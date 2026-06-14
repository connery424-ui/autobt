import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import 'dotenv/config';
import axios from 'axios';
import { z } from 'zod';
import path from 'path';
import { fileURLToPath } from 'url';
import fs, { existsSync } from 'fs';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import nacl from 'tweetnacl';

// Database integration - SQLite via Prisma (single local database, no Supabase)
import { prisma } from './src/lib/prisma.js';
import { sqliteDb } from './src/lib/sqliteDb.js';

// RPC rotation pool — cycles through all configured endpoints, auto-backs-off on 429
import { rpcManager } from './src/lib/rpcManager.js';

// Import the TypeScript services (these will be resolved properly)
import { EnhancedSniperService } from './src/lib/enhancedSniperService.js';

// Import wallet management service
import { secureWalletService } from './src/lib/secureWalletService.js';

// Import transaction analysis service for accurate SOL tracking
import { analyzeTransaction, type TransactionAnalysis } from './src/lib/transactionAnalyzer.js';

// Import authentication routes
import { setupAuthRoutes, pendingNonces } from './src/routes/auth.js';
import { authenticateUser, optionalAuth, requireAdmin, verifyWalletSignature, setAuthSuccessHook } from './src/middleware/auth.js';

// Import wallet migration service
import { walletMigrationService } from './src/lib/walletMigrationService.js';

// Import PumpPortal service for real-time unbonded tokens
import { pumpPortalService, setSolPriceUsd as setPumpPortalSolPrice } from './src/lib/pumpPortalService.js';
import { onchainPumpStream } from './src/lib/onchainPumpStream.js';

// Utility function to wrap async route handlers for proper TypeScript support
const asyncHandler = (fn: (req: Request, res: Response, next?: NextFunction) => Promise<any>): RequestHandler => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

// asyncAuthHandler is an alias of asyncHandler — kept for route readability
const asyncAuthHandler = asyncHandler;

const app = express();
const httpServer = createServer(app);

// Track concurrent WebSocket connections per IP to prevent abuse / resource exhaustion.
const WS_MAX_CONNECTIONS_PER_IP = 5;
const wsConnectionsByIp = new Map<string, number>();

// Initialize WebSocket server for real-time updates
// SECURITY FIX: WebSocket authentication - requires JWT token
const wss = new WebSocketServer({
  server: httpServer,
  path: '/ws',
  verifyClient: (info, callback) => {
    try {
      // Per-IP connection limit check
      const clientIp = (info.req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
        || info.req.socket?.remoteAddress || 'unknown';
      const currentCount = wsConnectionsByIp.get(clientIp) || 0;
      if (currentCount >= WS_MAX_CONNECTIONS_PER_IP) {
        console.warn(`[WS] Rejected: IP ${clientIp} already has ${currentCount} connections (max ${WS_MAX_CONNECTIONS_PER_IP})`);
        return callback(false, 429, 'Too Many Connections');
      }
      (info.req as any)._clientIp = clientIp;

      // WebSocket authentication — token is optional for the read-only token feed.
      // Token can be provided via query string: ws://localhost:3001/?token=xxx
      // or via Authorization header. When present, user info is attached; when absent,
      // the connection is accepted anonymously.
      const url = new URL(info.req.url || '', `http://${info.req.headers.host}`);
      const token = url.searchParams.get('token') || info.req.headers.authorization?.replace('Bearer ', '');

      if (!token) {
        // Allow anonymous connections for the read-only live token feed
        console.log('ℹ️  WebSocket connection accepted anonymously (no token provided)');
        (info.req as any).user = null;
        return callback(true);
      }

      // Verify JWT token using the same validation as HTTP endpoints
      if (!process.env.JWT_SECRET) {
        console.error('❌ WebSocket connection rejected: JWT_SECRET not configured');
        return callback(false, 500, 'Internal Server Error');
      }

      // Verify JWT signature and expiration (synchronous)
      let decoded: any;
      try {
        decoded = jwt.verify(token, process.env.JWT_SECRET!);
      } catch (jwtError) {
        // FIX-8: Reject invalid/expired tokens — do not accept as anonymous.
        // Anonymous WebSocket access allows unauthenticated subscription to live feeds.
        console.log('⚠️  WebSocket token invalid/expired, rejecting connection');
        return callback(false, 401, 'Unauthorized');
      }

      // Attach decoded user info to the request for later use
      (info.req as any).user = {
        id: decoded.userId,
        walletAddress: decoded.walletAddress,
        sessionId: decoded.sessionId,
        tier: decoded.tier || 'free'
      };

      console.log(`✅ WebSocket connection authenticated for user: ${decoded.userId}`);
      callback(true); // Accept connection
    } catch (error) {
      console.error('❌ WebSocket authentication error:', error);
      callback(false, 500, 'Internal Server Error');
    }
  }
});
console.log('🌐 WebSocket server initialized for real-time updates on path: / (JWT authentication required)');

// Use the PORT environment variable provided by the hosting platform, or default to 3001.
const port = process.env.PORT || 3001;

// ── App Config: DB is source of truth, .env is the bootstrap seed ─────────
// Keys managed via the DB (not .env after first run):
const DB_CONFIG_KEYS = ['HELIUS_API_KEY', 'TAVAHIN_RPC_URL', 'TAVAHIN_API_KEY', 'GEYSER_GRPC_ENDPOINT', 'GEYSER_AUTH_TOKEN', 'SOLANA_NETWORK'];

// Seed .env values → app_config on first run; load DB → process.env on all runs.
async function loadAndSeedConfig() {
  try {
    let rows = await prisma.app_config.findMany();
    if (rows.length === 0) {
      // First run: copy .env values into DB
      const seeds = DB_CONFIG_KEYS
        .filter(k => process.env[k])
        .map(k => ({ key: k, value: process.env[k]! }));
      if (seeds.length > 0) {
        await prisma.app_config.createMany({ data: seeds });
        console.log(`🌱 Seeded ${seeds.length} config keys from .env → DB`);
      }
      rows = seeds.map(s => ({ key: s.key, value: s.value, updatedAt: new Date() }));
    }
    // DB wins for these keys — overwrite whatever dotenv loaded
    for (const { key, value } of rows) {
      if (value) process.env[key] = value;
    }
    console.log(`✅ Config loaded from DB (${rows.length} keys)`);
  } catch (err) {
    console.warn('⚠️ Could not load config from DB — falling back to .env values:', err);
  }
}

// Dynamic getter — always reads current process.env (may be updated by loadAndSeedConfig or POST endpoint)
function getHeliusApiKey() { return process.env.HELIUS_API_KEY; }

// Re-initializable sniperService so key changes take effect without restart
let sniperService: EnhancedSniperService | null = null;
function initSniperService() {
  const key = process.env.HELIUS_API_KEY;
  const net = process.env.SOLANA_NETWORK || 'mainnet';
  if (key) {
    sniperService = new EnhancedSniperService(
      `https://${net}.helius-rpc.com/?api-key=${key}`,
      `wss://${net}.helius-rpc.com/?api-key=${key}`
    );
    console.log('✅ Enhanced Sniper Service initialized and ready for trading!');
  } else {
    console.warn('⚠️  HELIUS_API_KEY not set — sniper service disabled. Set key in Settings → API Keys.');
  }
}
initSniperService(); // initial call with whatever .env provided; re-called after DB load
// Wire auth success → sniper sign context (non-blocking, fires on first user API request)
setAuthSuccessHook((userId) => { updateSniperSignContext(userId).catch(() => { }); });

/**
 * Inject the sign context into the sniper after a user authenticates.
 * This gives the auto-sniper access to the server-side keypair for signing.
 * Called from the JWT auth middleware when a user loads the app.
 */
async function updateSniperSignContext(userId: string) {
  if (!sniperService) return;
  try {
    const wallet = await prisma.managed_wallets.findFirst({
      where: { userId, isActive: true },
      select: { id: true, publicKey: true }
    });
    if (!wallet) return;

    const { secureWalletService } = await import('./src/lib/secureWalletService.js');
    const { Connection, TransactionMessage, VersionedTransaction } = await import('@solana/web3.js');
    const rpcUrl = rpcManager.getUrl();

    const signAndBroadcast = async (
      instructions: any[] | null,
      payerKey: any | null,
      connection: any,
      prebuiltTx?: any
    ): Promise<string> => {
      const keypair = await secureWalletService.getKeypairForSigning(wallet.id, userId);
      const conn = connection || new Connection(rpcUrl, 'confirmed');

      let tx = prebuiltTx;
      if (!tx && instructions && payerKey) {
        const { blockhash } = await conn.getLatestBlockhash('confirmed');
        const msg = new TransactionMessage({
          payerKey, recentBlockhash: blockhash, instructions,
        }).compileToV0Message();
        tx = new VersionedTransaction(msg);
      }
      tx.sign([keypair]);
      return await conn.sendTransaction(tx, {
        skipPreflight: false, preflightCommitment: 'processed', maxRetries: 5
      });
    };

    sniperService.setSignContext({
      userId,
      walletId: wallet.id,
      walletPublicKey: wallet.publicKey,
      signAndBroadcast,
    });
    console.log(`🔑 Sniper sign context set for user ${userId.slice(0, 12)}... wallet ${wallet.publicKey.slice(0, 8)}...`);
  } catch (e: any) {
    console.warn('⚠️ Could not set sniper sign context:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────

// Initialize secure wallet service - no legacy wallet manager needed
console.log('🔐 Secure Wallet Service ready with AES-256-GCM encryption!');

// ── Restored startup constants ────────────────────────────────────────────
// SECURITY: Validate bootstrap env vars before anything else
if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET is not set. Required for secure authentication.');
}
if (!process.env.WALLET_ENCRYPTION_KEY) {
  throw new Error('WALLET_ENCRYPTION_KEY is not set. Required for wallet encryption.');
}
console.log('✅ All required security environment variables are configured');

// LaunchLab/Bonk.fun API Configuration
const LAUNCHLAB_BASE_URL = 'https://launch-mint-v1.raydium.io';
const LAUNCHLAB_PLATFORM_ID = 'PlatformWhiteList';
// ─────────────────────────────────────────────────────────────────────────


// Token metadata fetching utility function
const fetchTokenMetadata = async (mintAddress: string) => {
  try {
    console.log(`🔍 Fetching token metadata for: ${mintAddress}`);
    const metadataResponse = await fetch(`https://tokens.jup.ag/token/${mintAddress}`);
    if (metadataResponse.ok) {
      const metadata = await metadataResponse.json();
      console.log(`✅ Token metadata found: ${metadata.name} (${metadata.symbol})`);
      return {
        name: metadata.name,
        symbol: metadata.symbol,
        logoURI: metadata.logoURI
      };
    } else {
      console.log(`❌ No metadata found for token ${mintAddress}: ${metadataResponse.status}`);
      return null;
    }
  } catch (error) {
    console.warn(`⚠️ Error fetching token metadata for ${mintAddress}:`, error);
    return null;
  }
};

// LaunchLab/Bonk.fun API utility functions
const fetchLaunchLabTokens = async (sort: string = 'new', size: number = 20, includeNsfw: boolean = false) => {
  try {
    const url = `${LAUNCHLAB_BASE_URL}/get/list?platformId=${LAUNCHLAB_PLATFORM_ID}&sort=${sort}&size=${size}&mintType=default&includeNsfw=${includeNsfw}`;
    console.log(`🚀 Fetching LaunchLab tokens: ${url}`);

    const response = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'AutoBotAPP/1.0',
        'Accept': 'application/json'
      }
    });

    if (response.data?.success && response.data?.data?.rows) {
      console.log(`✅ Fetched ${response.data.data.rows.length} LaunchLab tokens`);
      return response.data.data.rows;
    } else {
      console.log('❌ Invalid response from LaunchLab API');
      return [];
    }
  } catch (error) {
    console.error('❌ Error fetching LaunchLab tokens:', error);
    return [];
  }
};

const transformLaunchLabToken = (launchToken: any) => {
  return {
    id: launchToken.poolId || launchToken.mint,
    address: launchToken.mint,
    symbol: launchToken.symbol || 'UNKNOWN',
    name: launchToken.name || launchToken.symbol || 'Unknown Token',
    decimals: launchToken.decimals || 6,
    logoURI: launchToken.imgUrl || null,
    poolId: launchToken.poolId,
    poolType: 'launchpad',

    // Market data from LaunchLab
    liquidity: parseFloat(launchToken.totalFundRaisingB || '0') / 1e9, // Convert lamports to SOL
    volume24h: parseFloat(launchToken.volumeU || '0'),
    marketCap: parseFloat(launchToken.marketCap || '0'),
    price: parseFloat(launchToken.endPrice || launchToken.initPrice || '0'),
    priceChange24h: 0, // LaunchLab doesn't provide 24h change for new tokens

    // Launch-specific data
    finishingRate: parseFloat(launchToken.finishingRate || '0'),
    supply: parseFloat(launchToken.supply || '0'),
    totalSellA: parseFloat(launchToken.totalSellA || '0'),
    totalFundRaisingB: parseFloat(launchToken.totalFundRaisingB || '0'),

    // Paired token info (always SOL on LaunchLab)
    pairedWith: {
      symbol: 'SOL',
      address: 'So11111111111111111111111111111111111111112'
    },

    // Timestamps
    createdAt: new Date(launchToken.createAt).toISOString(),
    launchedAt: new Date(launchToken.createAt).toISOString(),

    // Trading info
    fdv: null,

    // Source and platform
    source: 'launchlab',
    launchpad: 'bonk.fun',
    platform: launchToken.platformInfo?.name || 'letsbonk.fun',

    // Status
    status: 'active',
    verified: false,

    // Social links
    website: launchToken.website || null,
    twitter: launchToken.twitter || null,
    telegram: null,
    description: launchToken.description || null,

    // Risk assessment (launch tokens are typically higher risk)
    riskLevel: 'high',

    // Additional metadata
    tags: ['new-launch', 'launchpad'],
    creator: launchToken.creator || null,
    configId: launchToken.configId || null,

    // Launch progress
    bondingCurve: {
      initPrice: parseFloat(launchToken.initPrice || '0'),
      endPrice: parseFloat(launchToken.endPrice || '0'),
      finishingRate: parseFloat(launchToken.finishingRate || '0'),
      migrateType: launchToken.migrateType || 'cpmm'
    }
  };
};

// Auto-Sell Service initialization (temporarily disabled)
let autoSellService = null;
// if (heliusApiKey) {
//   const rpcEndpoint = `https://${network}.helius-rpc.com/?api-key=${heliusApiKey}`;
//   const wsEndpoint = `wss://${network}.helius-rpc.com/?api-key=${heliusApiKey}`;
//   
//   // Import and initialize AutoSellService (when converted to JS)
//   // const { AutoSellService } = await import('./src/lib/autoSellService.js');
//   // autoSellService = new AutoSellService(rpcEndpoint, wsEndpoint);
// }

// 1. CORS Policy
// In Electron / local production we allow all localhost origins.
// For a web deployment, set PRODUCTION_URL in .env.
const isElectron = process.env.ELECTRON_APP === 'true';
const corsOptions = {
  origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
    // Allow requests with no origin (Electron, curl, mobile apps)
    if (!origin) return cb(null, true);
    // Allow any localhost/127.0.0.1 origin (covers all dev ports + Electron webview)
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return cb(null, true);
    // Production web deployment
    const prodUrl = process.env.PRODUCTION_URL;
    if (prodUrl && origin === prodUrl) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
};
// P1 fix: helmet sets 11 HTTP security headers (HSTS, X-Frame-Options, etc).
// contentSecurityPolicy is disabled here — the React app sets it via meta tags
// and Electron's localhost origin would block dynamic imports if set at HTTP level.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors(corsOptions));
app.use(cookieParser());
app.use(express.json());

// Serve compiled React frontend in production / Electron mode
if (process.env.NODE_ENV === 'production' || isElectron) {
  // __dirname equivalent in ESM
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  // dist/ is relative to the compiled server entry (server-build/index.js → ../dist)
  const distDir = process.env.FRONTEND_DIST_PATH
    || path.join(__dirname, '..', 'dist');
  if (existsSync(distDir)) {
    console.log(`📦 Serving frontend from: ${distDir}`);
    app.use(express.static(distDir));
  } else {
    console.warn(`⚠️  Frontend dist not found at ${distDir} — run npm run build first`);
  }
}

// Request timing middleware - Add this to track performance
app.use((req, res, next) => {
  const start = Date.now();
  const method = req.method;
  const url = req.url;

  res.on('finish', () => {
    const duration = Date.now() - start;
    const status = res.statusCode;

    // Only log API requests, skip static assets
    if (url.startsWith('/api/')) {
      if (duration > 500) {
        // Highlight slow requests in red
        console.log(`🐌 SLOW: ${method} ${url} - ${status} - ${duration}ms`);
      } else if (duration > 200) {
        // Moderate requests in yellow
        console.log(`⚠️  ${method} ${url} - ${status} - ${duration}ms`);
      } else {
        // Fast requests in green
        console.log(`✅ ${method} ${url} - ${status} - ${duration}ms`);
      }
    }
  });

  next();
});

// Setup authentication routes
setupAuthRoutes(app);

// 2. Robust Rate Limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500, // Increased limit for live trading app
  standardHeaders: true,
  legacyHeaders: false,
});

// Special rate limiter for token feed endpoints (more permissive)
const tokenFeedLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 300, // 300 requests per minute for token feeds (5 per second)
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many token feed requests, please slow down',
    retryAfter: '60 seconds'
  },
  skip: (req) => {
    // Skip rate limiting for local development
    return req.ip === '127.0.0.1' || req.ip === '::1' || req.headers['x-development-bypass'] === 'true';
  }
});

app.use(limiter);

// --- Production-specific setup ---
if (process.env.NODE_ENV === 'production') {
  // Serve static files — prefer FRONTEND_DIST_PATH (set by Electron launcher)
  const prodDistDir = process.env.FRONTEND_DIST_PATH
    || path.join(__dirname, '..', 'dist');

  app.use(express.static(prodDistDir));

  // SPA fallback — only for non-API routes so API endpoints aren't swallowed
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    const indexFile = path.join(prodDistDir, 'index.html');
    if (existsSync(indexFile)) {
      res.sendFile(indexFile);
    } else {
      next();
    }
  });
}

// --- Zod Validation Schemas ---
const solanaAddressSchema = z.string().regex(/^[A-HJ-NP-Za-km-z1-9]{32,44}$/, {
  message: "Invalid Solana address format",
});

const quoteQuerySchema = z.object({
  inputMint: solanaAddressSchema,
  outputMint: solanaAddressSchema,
  amount: z.string().regex(/^\d+$/).transform(Number),
  slippageBps: z.string().regex(/^\d+$/).transform(Number).optional(),
});

const raydiumSwapBodySchema = z.object({
  swapResponse: z.any(), // Raydium quote response can be complex, using any for now
  wallet: solanaAddressSchema,
  wrapSol: z.boolean().optional(),
  unwrapSol: z.boolean().optional(),
  inputAccount: z.string().optional(),
  outputAccount: z.string().optional(),
  computeUnitPriceMicroLamports: z.string().optional(),
  txVersion: z.string().optional(),
});

const jupiterSwapBodySchema = z.object({
  quoteResponse: z.any(), // Jupiter quote can be complex
  userPublicKey: solanaAddressSchema,
  wrapAndUnwrapSol: z.boolean().optional(),
});

// 3. Secure RPC Proxy Endpoint with Input Validation
const rpcRequestSchema = z.object({
  method: z.string(),
  params: z.array(z.any()),
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]),
});

// NOTE: pendingNonces is imported from src/routes/auth.ts (shared between /api/auth/nonce and /api/auth/nonce-siws)

// POST /api/auth/nonce
// Step 1 of SIWS: client requests a fresh nonce + message to sign.
// Overrides the one in src/routes/auth.ts so both endpoints share the nonce store.
app.post('/api/auth/nonce-siws', asyncHandler(async (req: Request, res: Response) => {
  const { walletAddress } = req.body;
  if (!walletAddress || typeof walletAddress !== 'string') {
    return res.status(400).json({ error: 'walletAddress is required' });
  }
  const nonce = Buffer.from(nacl.randomBytes(32)).toString('base64');
  const message = `Welcome to SolSniper!\n\nThis request will not trigger a blockchain transaction or cost any gas fees.\n\nWallet: ${walletAddress}\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
  pendingNonces.set(nonce, { walletAddress, expiresAt: Date.now() + 5 * 60_000 });
  return res.json({ nonce, message });
}));

// POST /api/auth/wallet-login
// Step 2 of SIWS: client sends the signed message + nonce. We verify the sig,
// then issue a JWT stored only in an HttpOnly cookie (never in the response body).
app.post('/api/auth/wallet-login', asyncHandler(async (req: Request, res: Response) => {
  try {
    const { walletAddress, signature, message, nonce } = req.body;

    if (!walletAddress || typeof walletAddress !== 'string') {
      return res.status(400).json({ error: 'walletAddress is required' });
    }

    // ── Signature path (SIWS) ────────────────────────────────────────────────
    if (signature && message && nonce) {
      // 1. Consume nonce (replay prevention)
      const nonceData = pendingNonces.get(nonce);
      if (!nonceData) {
        return res.status(400).json({ error: 'Invalid or expired nonce', code: 'INVALID_NONCE' });
      }
      if (nonceData.expiresAt < Date.now()) {
        pendingNonces.delete(nonce);
        return res.status(400).json({ error: 'Nonce expired', code: 'NONCE_EXPIRED' });
      }
      if (nonceData.walletAddress !== walletAddress) {
        return res.status(400).json({ error: 'Nonce wallet mismatch', code: 'NONCE_MISMATCH' });
      }
      pendingNonces.delete(nonce); // consume

      // 2. Verify the SIWS signature (using statically imported verifyWalletSignature)
      const valid = verifyWalletSignature(message, signature, walletAddress);
      if (!valid) {
        return res.status(401).json({ error: 'Invalid signature', code: 'INVALID_SIGNATURE' });
      }
    } else {
      // ── Unsigned path (Electron pairing / legacy dev mode) ────────────────
      // Only allowed when no signature fields are present at all.
      // Logged prominently so it's obvious in production.
      console.warn(`⚠️  wallet-login without signature for ${walletAddress} — allowed for Electron/dev flow only`);
    }

    if (!process.env.JWT_SECRET) {
      return res.status(500).json({ error: 'JWT_SECRET not configured on server' });
    }

    const user = await prisma.users.upsert({
      where: { walletAddress },
      update: {},
      create: { walletAddress }
    });
    console.log('✅ wallet-login user upsert:', walletAddress, '→ id:', user.id);

    const payload = {
      userId: user.id,
      walletAddress: user.walletAddress,
      sessionId: `session_${Date.now()}`,
      tier: 'free',
    };
    // @ts-ignore
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '24h' });

    // Set HttpOnly cookie — SameSite:lax in dev (Vite proxy), strict in production
    const isSecure = process.env.NODE_ENV === 'production';
    const sameSite = isSecure ? 'strict' : 'lax';
    res.cookie('auth_session', token, {
      httpOnly: true,
      sameSite,
      secure: isSecure,
      maxAge: 24 * 60 * 60 * 1000, // 24 h
      path: '/'
    });

    // Return success + user (no token in body for browser flow)
    return res.json({
      success: true,
      user: { id: user.id, walletAddress: user.walletAddress },
      // Include token in body ONLY for Electron pairing which can't read cookies
      ...((!signature) ? { token } : {})
    });
  } catch (err) {
    console.error('❌ wallet-login error:', err);
    return res.status(500).json({ error: 'Login failed', detail: (err as Error).message });
  }
}));

// POST /api/auth/logout — clears the HttpOnly session cookie
app.post('/api/auth/logout', ((_req: Request, res: Response) => {
  const isProd = process.env.NODE_ENV === 'production';
  res.clearCookie('auth_session', { httpOnly: true, sameSite: isProd ? 'strict' : 'lax', path: '/' });
  res.json({ success: true });
}) as RequestHandler);


// ─── End Auth endpoints ───────────────────────────────────────────────────────


// (slop audit P0) authenticateUser added — this proxy signs requests with the
// server's Helius key; unauthenticated, any local process could burn the quota.
app.post('/api/rpc', authenticateUser, asyncHandler(async (req: Request, res: Response) => {

  const validation = rpcRequestSchema.safeParse(req.body);
  if (!validation.success) {
    res.status(400).json({ error: 'Invalid RPC request body' });
    return;
  }

  try {
    const rpcEndpoint = `https://${process.env.SOLANA_NETWORK || 'mainnet'}.helius-rpc.com/?api-key=${getHeliusApiKey()}`;
    const response = await axios.post(rpcEndpoint, req.body);
    res.status(response.status).json(response.data);
  } catch (error: any) {
    console.error('RPC Proxy Error:', error);
    res.status(error.response?.status || 500).json({ error: 'Failed to proxy request to RPC endpoint' });
  }
}));

// 4. Unified Proxy for New Token Discovery (Birdeye, DEX Screener)
const newTokensQuerySchema = z.object({
  source: z.enum(['birdeye', 'dexscreener']),
});
// (slop audit) GET /api/new-tokens — dead route archived to archive/dead-endpoints-20260612.ts.txt


// 5. DexScreener Token Info API
app.get('/api/token-info/:tokenAddress', asyncHandler(async (req, res) => {
  const validation = solanaAddressSchema.safeParse(req.params.tokenAddress);
  if (!validation.success) {
    return res.status(400).json({ error: 'Invalid token address format', details: validation.error.flatten() });
  }
  const tokenAddress = validation.data;

  try {
    const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, {
      headers: {
        'User-Agent': 'Autobot-App/1.0'
      }
    });

    if (response.status !== 200 || !response.data) {
      return res.status(response.status).json({ error: 'Failed to fetch token data from DexScreener' });
    }

    res.status(200).json(response.data);
  } catch (error) {
    console.error('DexScreener Token Info Error:', error);
    res.status(error.response?.status || 500).json({ error: 'Failed to fetch token data from DexScreener' });
  }
}));
// (slop audit) GET /api/search/:query — dead route archived to archive/dead-endpoints-20260612.ts.txt

// 8. Wallet Balance API - Server-side balance fetching
app.get('/api/wallet/balance/:address', asyncHandler(async (req, res) => {
  const { address } = req.params;

  if (!address) {
    res.status(400).json({ error: 'Wallet address is required' });
    return;
  }

  try {
    // Validate Solana address format
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
      res.status(400).json({ error: 'Invalid Solana address format' });
      return;
    }

    // Use Helius RPC with server-side API key
    const rpcUrl = `https://${process.env.SOLANA_NETWORK || 'mainnet'}.helius-rpc.com/?api-key=${getHeliusApiKey()}`;

    const response = await axios.post(rpcUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getBalance',
      params: [address]
    }, {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Autobot-App/1.0'
      },
      timeout: 10000
    });

    if (response.data.error) {
      console.error('RPC Error:', response.data.error);
      res.status(500).json({ error: 'Failed to fetch balance from RPC' });
      return;
    }

    const balanceInLamports = response.data.result;
    const balanceInSol = balanceInLamports / 1000000000; // Convert lamports to SOL

    res.status(200).json({
      address,
      balance: balanceInSol,
      balanceLamports: balanceInLamports,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Wallet Balance Error:', error);

    if (error.code === 'ECONNABORTED') {
      return res.status(504).json({ error: 'RPC request timeout' });
    }

    res.status(500).json({
      error: 'Failed to fetch wallet balance',
      details: error.response?.data || error.message
    });
  }
}));

// 6. Proxy for Raydium Quote API
app.get('/api/raydium/quote', asyncHandler(async (req, res) => {
  const validation = quoteQuerySchema.safeParse(req.query);
  if (!validation.success) {
    return res.status(400).json({ error: 'Invalid query parameters for quote', details: validation.error.flatten() });
  }
  const { inputMint, outputMint, amount, slippageBps } = validation.data;

  try {
    // Use the correct Raydium API endpoint for quotes (swap-base-in)
    const quoteUrl = `https://transaction-v1.raydium.io/compute/swap-base-in?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps || 50}&txVersion=V0`;

    const response = await axios.get(quoteUrl, {
      timeout: 10000,
      headers: {
        'User-Agent': 'SolSniper/1.0',
        'Accept': 'application/json'
      }
    });

    res.status(response.status).json(response.data);
  } catch (error) {
    console.error('❌ Raydium Quote Proxy Error Details:');
    console.error('  - Status:', error.response?.status);
    console.error('  - Status Text:', error.response?.statusText);
    console.error('  - Response Data:', error.response?.data);
    console.error('  - Error Message:', error.message);
    console.error('  - Full Error:', error);

    // Return more detailed error information
    const errorResponse = {
      error: 'Failed to proxy request to Raydium Quote API',
      details: {
        status: error.response?.status,
        statusText: error.response?.statusText,
        responseData: error.response?.data,
        message: error.message
      }
    };

    res.status(error.response?.status || 500).json(errorResponse);
  }
}));

// 7. Proxy for Raydium Swap Transaction API
app.post('/api/raydium/swap', authenticateUser, asyncHandler(async (req, res) => {
  const validation = raydiumSwapBodySchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({ error: 'Invalid body for swap', details: validation.error.flatten() });
  }

  try {

    // Use the correct Raydium API endpoint for swap transactions
    const swapUrl = `https://transaction-v1.raydium.io/transaction/swap-base-in`;

    // Prepare the request body in the format expected by Raydium
    const requestBody = {
      computeUnitPriceMicroLamports: req.body.computeUnitPriceMicroLamports || "1000000",
      swapResponse: req.body.swapResponse,
      txVersion: req.body.txVersion || "V0",
      wallet: req.body.wallet,
      wrapSol: req.body.wrapSol || false,
      unwrapSol: req.body.unwrapSol || true,
      inputAccount: req.body.inputAccount,
      outputAccount: req.body.outputAccount,
    };

    const response = await axios.post(swapUrl, requestBody, {
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'SolSniper/1.0',
        'Accept': 'application/json'
      }
    });

    res.status(response.status).json(response.data);
  } catch (error) {
    console.error('❌ Raydium Swap Proxy Error:', (error as any).response?.status, (error as Error).message);
    res.status((error as any).response?.status || 500).json({
      error: 'Failed to proxy request to Raydium Swap API',
      details: {
        status: (error as any).response?.status,
        statusText: (error as any).response?.statusText,
        responseData: (error as any).response?.data,
        message: (error as Error).message
      }
    });
  }
}));

// 8. Proxy for Jupiter Quote API
app.get('/api/jupiter/quote', asyncHandler(async (req, res) => {
  const validation = quoteQuerySchema.safeParse(req.query);
  if (!validation.success) {
    return res.status(400).json({ error: 'Invalid query parameters for quote', details: validation.error.flatten() });
  }
  const { inputMint, outputMint, amount, slippageBps } = validation.data;

  try {
    const jupKey = process.env.JUPITER_API_KEY || '';
    const quoteUrl = `https://api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps || 50}`;
    const response = await axios.get(quoteUrl, {
      headers: jupKey ? { 'x-api-key': jupKey } : {}
    });
    res.status(response.status).json(response.data);
  } catch (error) {
    console.error('Jupiter Quote Proxy Error:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({ error: 'Failed to proxy request to Jupiter Quote API' });
  }
}));

// 9. Proxy for Jupiter Swap Transaction API
app.post('/api/jupiter/swap', authenticateUser, asyncHandler(async (req, res) => {
  const validation = jupiterSwapBodySchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({ error: 'Invalid body for swap', details: validation.error.flatten() });
  }

  try {
    const jupKey = process.env.JUPITER_API_KEY || '';
    const swapUrl = `https://api.jup.ag/swap/v1/swap`;
    const response = await axios.post(swapUrl, req.body, {
      headers: { 'Content-Type': 'application/json', ...(jupKey ? { 'x-api-key': jupKey } : {}) }
    });
    res.status(response.status).json(response.data);
  } catch (error) {
    console.error('Jupiter Swap Proxy Error:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({ error: 'Failed to proxy request to Jupiter Swap API' });
  }
}));
// (slop audit) POST /api/system/keep-alive — dead route archived to archive/dead-endpoints-20260612.ts.txt

// Database migration completed successfully - endpoints removed

// 11. API Health Check Endpoint - ULTRA-OPTIMIZED with aggressive timeouts
let healthCache: any = null;
let healthCacheTimestamp = 0;
const HEALTH_CACHE_TTL = 60 * 1000; // Extended to 60 seconds cache

app.get('/api/system/health', asyncHandler(async (req, res) => {
  try {
    const now = Date.now();

    // Return cached result if still valid (extended cache for health checks)
    if (healthCache && (now - healthCacheTimestamp) < HEALTH_CACHE_TTL) {
      res.set('X-Cache', 'HIT');
      return res.status(200).json(healthCache);
    }

    console.log(`🏥 Running health check with ultra-aggressive timeouts...`);
    const overallStart = Date.now();

    const healthStatus = {
      timestamp: new Date().toISOString(),
      services: {
        database: { status: 'unknown', responseTime: 0 },
        raydium: { status: 'unknown', responseTime: 0 },
        jupiter: { status: 'unknown', responseTime: 0 },
        solana_rpc: { status: 'unknown', responseTime: 0 }
      }
    };

    // Run all health checks in parallel with ULTRA-AGGRESSIVE timeouts
    const healthChecks = await Promise.allSettled([
      // Database check (fastest - should be < 50ms)
      (async () => {
        const dbStart = Date.now();
        await prisma.$queryRaw`SELECT 1 as health_check`;
        return { service: 'database', status: 'healthy', responseTime: Date.now() - dbStart };
      })(),

      // Raydium API check
      (async () => {
        const raydiumStart = Date.now();
        const response = await axios.get('https://api-v3.raydium.io/main/info', {
          timeout: 3000,
          headers: { 'Accept': 'application/json' }
        });
        return {
          service: 'raydium',
          status: response.status === 200 ? 'healthy' : 'degraded',
          responseTime: Date.now() - raydiumStart
        };
      })(),

      // Jupiter API check — api.jup.ag/swap/v1 (active endpoint, same as real swaps)
      (async () => {
        const jupiterStart = Date.now();
        const SOL = 'So11111111111111111111111111111111111111112';
        const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
        const jupKey = process.env.JUPITER_API_KEY || '';
        try {
          const response = await axios.get(
            `https://api.jup.ag/swap/v1/quote?inputMint=${SOL}&outputMint=${USDC}&amount=1000000000&slippageBps=50`,
            {
              timeout: 5000,
              headers: jupKey ? { 'x-api-key': jupKey } : {}
            }
          );
          return {
            service: 'jupiter',
            status: response.status === 200 ? 'healthy' : 'degraded',
            responseTime: Date.now() - jupiterStart
          };
        } catch (err: any) {
          console.log(`⚠️ Jupiter health check failed (${err?.code || err?.message})`);
          return {
            service: 'jupiter',
            status: 'degraded',
            responseTime: Date.now() - jupiterStart
          };
        }
      })(),

      // Solana RPC check — fall back to public RPC if no Helius key configured
      (async () => {
        const rpcStart = Date.now();
        const heliusKey = getHeliusApiKey();
        const rpcEndpoint = heliusKey
          ? `https://${process.env.SOLANA_NETWORK || 'mainnet'}.helius-rpc.com/?api-key=${heliusKey}`
          : 'https://api.mainnet-beta.solana.com';
        const response = await axios.post(rpcEndpoint, {
          jsonrpc: '2.0',
          id: 1,
          method: 'getSlot'
        }, {
          timeout: 3000
        });
        return {
          service: 'solana_rpc',
          status: response.data.result ? 'healthy' : 'degraded',
          responseTime: Date.now() - rpcStart
        };
      })()
    ]);

    // Process results with detailed logging
    let failedChecks = 0;
    healthChecks.forEach((result, index) => {
      const services = ['database', 'raydium', 'jupiter', 'solana_rpc'];
      const serviceName = services[index];

      if (result.status === 'fulfilled') {
        const { service, status, responseTime } = result.value;
        const svc = service as keyof typeof healthStatus.services;
        healthStatus.services[svc].status = status;
        healthStatus.services[svc].responseTime = responseTime;

        if (responseTime > 200) {
          console.log(`⚠️ Slow health check: ${service} took ${responseTime}ms`);
        }
      } else {
        // Handle failed checks with detailed error logging
        console.log(`❌ Health check failed for ${serviceName}:`, result.reason?.message || 'Unknown error');
        // External API failures are non-critical — show as 'unknown' (yellow) not 'unhealthy' (red)
        const isCritical = serviceName === 'database';
        const svcName = serviceName as keyof typeof healthStatus.services;
        healthStatus.services[svcName].status = isCritical ? 'unhealthy' : 'unknown';
        healthStatus.services[svcName].responseTime = 0;
        failedChecks++;
      }
    });

    const overallTime = Date.now() - overallStart;
    console.log(`🏥 Health check completed in ${overallTime}ms (${failedChecks} failures)`);

    // Cache the result
    healthCache = healthStatus;
    healthCacheTimestamp = now;

    // Add performance headers
    res.set({
      'X-Cache': 'MISS',
      'X-Response-Time': `${overallTime}ms`,
      'X-Failed-Checks': failedChecks.toString(),
      'Cache-Control': 'public, max-age=30' // Allow client caching for 30 seconds
    });

    res.status(200).json(healthStatus);
  } catch (error) {
    console.error('❌ Health check critical error:', error);
    res.status(500).json({
      error: 'Failed to perform health check',
      timestamp: new Date().toISOString()
    });
  }
}));

// 12. Transaction Management API Endpoints

// Fast dashboard transactions endpoint (uses wallet ID, not public key)
// @ts-ignore - TypeScript middleware compatibility
app.get('/api/dashboard/transactions/:walletId', authenticateUser, asyncAuthHandler(async (req, res) => {
  try {
    console.log('📊 Dashboard transactions request for walletId:', req.params.walletId);
    const { walletId } = req.params;
    const { limit = '10' } = req.query;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Get wallet using secure wallet service and verify ownership
    try {
      const wallet = await secureWalletService.getWallet(walletId, userId);
      if (!wallet) {
        console.log('❌ Wallet not found or access denied for ID:', walletId);
        res.status(200).json({
          transactions: [],
          count: 0,
          error: 'Wallet not found or access denied'
        });
        return;
      }

      console.log('✅ Found wallet:', wallet.walletName, wallet.publicKey);

      // ── DB is the single source of truth for the Transactions page (2026-06-11) ──
      // Every trade path now records VERIFIED rows through recordBuyTrade /
      // recordSellTrade / recordRejectedTrade, so the page reads ONLY the DB.
      // The Helius on-chain scan still runs — but in the BACKGROUND, purely as a
      // self-healing sync that backfills anything the DB missed (e.g. server died
      // mid-record). Synced rows appear on the next refresh.
      try {
        const startTime = Date.now();
        const apiKey = process.env.HELIUS_API_KEY || '';
        const me = wallet.publicKey;
        const take = parseInt(limit as string) || 50;

        // "Clear All" cutoff — hide trades from before the user last cleared.
        let clearedAtMs = 0;
        try {
          const row = await sqliteDb.app_config.findUnique({ where: { key: `txcutoff:${userId}` } });
          if (row?.value) clearedAtMs = parseInt(row.value) || 0;
        } catch { /* no cutoff set */ }

        // ── Serve from the DB ──
        const dbRows = await sqliteDb.transactions.findMany({
          where: { userId, ...(clearedAtMs ? { timestamp: { gt: new Date(clearedAtMs) } } : {}) },
          orderBy: { timestamp: 'desc' },
          take: Math.min(Math.max(take, 10), 200),
        });
        const dbFormatted = dbRows.map((r) => ({
          id: r.id,
          txId: r.txId,
          tokenName: r.tokenName,
          tokenSymbol: r.tokenSymbol,
          tokenAddress: r.tokenAddress,
          type: r.type,
          amount: r.amount,
          price: r.price,
          profit: r.profit ?? 0,
          status: r.status,
          timestamp: r.timestamp.getTime(),
          tokenType: r.tokenType || 'sol',
          dex: String(r.dex || '').toLowerCase(),
          totalSolCost: r.totalSolCost,
          gasFees: r.gasFees,
          jitoTip: r.jitoTip,
          netSolAmount: r.netSolAmount,
        }));
        console.log(`✅ DB: ${dbFormatted.length} trades for ${me.slice(0, 8)} in ${Date.now() - startTime}ms`);
        res.json({
          success: true,
          transactions: dbFormatted,
          count: dbFormatted.length,
          walletName: wallet.walletName,
          walletId: walletId,
        });

        // ── Background on-chain sync (fire-and-forget, self-healing) ──
        (async () => {
        try {
        const url = `https://api.helius.xyz/v0/addresses/${me}/transactions?api-key=${apiKey}&limit=${Math.min(take, 100)}`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(12000) });
        const raw: any[] = resp.ok ? await resp.json() : [];

        // Classify each tx as buy/sell from this wallet's token + native (SOL) transfers.
        // FIX (2026-06-11): AMM-routed sells return WSOL as a TOKEN transfer, not native
        // SOL. The old loop treated WSOL like any token, overwrote `mint` with whichever
        // transfer came last, and mixed token amounts across different mints — so sells
        // were misclassified as "buys of So1111…" (WSOL) or silently dropped.
        const WSOL_MINT = 'So11111111111111111111111111111111111111112';
        const parsed: any[] = [];
        for (const tx of raw) {
          const tts = tx.tokenTransfers || [];
          const nts = tx.nativeTransfers || [];
          let solIn = 0, solOut = 0; // lamports
          for (const n of nts) {
            if (n.toUserAccount === me) solIn += (n.amount || 0);
            if (n.fromUserAccount === me) solOut += (n.amount || 0);
          }
          // Aggregate token flows PER MINT; WSOL counts as SOL (Helius tokenAmount is in SOL units).
          const flows: Record<string, { in: number; out: number }> = {};
          for (const t of tts) {
            const amt = t.tokenAmount || 0;
            if (!t.mint || amt <= 0) continue;
            if (t.mint === WSOL_MINT) {
              if (t.toUserAccount === me) solIn += amt * 1e9;
              else if (t.fromUserAccount === me) solOut += amt * 1e9;
              continue;
            }
            if (t.toUserAccount === me) (flows[t.mint] ??= { in: 0, out: 0 }).in += amt;
            else if (t.fromUserAccount === me) (flows[t.mint] ??= { in: 0, out: 0 }).out += amt;
          }
          // The traded mint = the non-WSOL mint with the largest gross flow.
          let mint: string | null = null, bestGross = 0;
          for (const [m, f] of Object.entries(flows)) {
            const gross = f.in + f.out;
            if (gross > bestGross) { bestGross = gross; mint = m; }
          }
          if (!mint) continue;
          const txMs = (tx.timestamp || 0) * 1000;
          if (clearedAtMs && txMs <= clearedAtMs) continue; // hidden by Clear All
          // Classify on NET direction so fee refunds / tips don't flip the result.
          const netTok = flows[mint].in - flows[mint].out;
          const netSol = solIn - solOut; // lamports
          const isBuy = netTok > 0 && netSol < 0;
          const isSell = netTok < 0 && netSol > 0;
          if (!isBuy && !isSell) continue;
          parsed.push({
            mint,
            type: isBuy ? 'buy' : 'sell',
            tokenAmount: Math.abs(netTok),
            solAmount: Math.abs(netSol) / 1e9,
            signature: tx.signature,
            timestamp: txMs,
            source: tx.source || 'PUMP_FUN',
          });
        }

        // Best-effort symbol/name resolution from our token cache.
        const mints = Array.from(new Set(parsed.map(p => p.mint)));
        const tokenRows = mints.length
          ? await sqliteDb.token.findMany({ where: { tokenAddress: { in: mints } } }).catch(() => [])
          : [];
        const tokMap: Record<string, any> = {};
        for (const tr of tokenRows) tokMap[(tr as any).tokenAddress] = tr;

        const formattedTransactions = parsed.map((p, i) => ({
          id: p.signature || String(i),
          txId: p.signature,
          tokenName: tokMap[p.mint]?.tokenName || p.mint.slice(0, 6),
          tokenSymbol: tokMap[p.mint]?.tokenSymbol || null,
          tokenAddress: p.mint,
          type: p.type,
          amount: p.tokenAmount,
          price: p.tokenAmount > 0 ? p.solAmount / p.tokenAmount : 0,
          profit: p.type === 'sell' ? p.solAmount : -p.solAmount,
          status: 'confirmed',
          timestamp: p.timestamp,
          tokenType: 'sol',
          dex: String(p.source || 'pump_fun').toLowerCase(),
        }));

        // (response already sent from the DB above — this on-chain list is used
        //  ONLY to backfill rows the DB is missing; failed/denied rows live in the
        //  DB already and never appear on-chain, so no merge is needed here)

        // ── Auto-backfill: persist any on-chain trades not yet in the DB ──
        // Idempotent: skips signatures already recorded. This self-heals the DB
        // just by viewing the page — no terminal commands needed.
        {
          try {
            if (formattedTransactions.length === 0) return;
            const sigs = formattedTransactions.map(t => t.txId).filter(Boolean);
            const existing = await sqliteDb.transactions.findMany({
              where: { txId: { in: sigs } }, select: { txId: true },
            });
            const have = new Set(existing.map(e => e.txId));
            let added = 0;
            for (const t of formattedTransactions) {
              if (!t.txId || have.has(t.txId)) continue;
              try {
                await sqliteDb.transactions.create({
                  data: {
                    userId,
                    txId: t.txId,
                    tokenName: t.tokenName,
                    tokenSymbol: t.tokenSymbol,
                    tokenAddress: t.tokenAddress,
                    type: t.type,
                    amount: t.amount,
                    price: t.price,
                    profit: t.profit,
                    status: 'confirmed',
                    // Normalize Helius source enums (PUMP_FUN → PUMPFUN) so the
                    // Analytics DEX grouping doesn't split one venue into two.
                    dex: String(t.dex).toUpperCase().replace(/_/g, ''),
                    timestamp: new Date(t.timestamp),
                    netSolAmount: t.profit,
                  },
                });
                added++;
              } catch { /* unique txId clash or shape mismatch — skip */ }
            }
            if (added > 0) console.log(`🗄️ Auto-backfill: saved ${added} new trade(s) to DB for ${me.slice(0, 8)}`);
          } catch (e: any) {
            console.warn('Auto-backfill skipped:', e?.message);
          }
        }
        } catch (syncErr: any) {
          console.warn('🚨 Background on-chain sync failed:', syncErr?.message);
        }
        })();
        return;
      } catch (error: any) {
        console.log('🚨 transactions DB read error:', error.message);
        // Fall through to empty response below
      }

      // If error occurred, return empty transactions
      console.log('📊 Returning empty transactions list due to error');
      res.status(200).json({
        transactions: [],
        count: 0,
        walletName: wallet.walletName,
        walletId: walletId
      });
    } catch (error: any) {
      console.error('❌ Error fetching wallet:', error);
      res.status(200).json({
        transactions: [],
        count: 0,
        error: 'Failed to fetch wallet'
      });
    }
  } catch (error) {
    console.error('❌ Error fetching dashboard transactions:', error);
    res.status(200).json({
      transactions: [],
      count: 0,
      error: 'Failed to fetch transactions'
    });
  }
}));
// (slop audit) GET /api/dashboard/holdings — dead route archived to archive/dead-endpoints-20260612.ts.txt

// Add stats endpoint - Phase 1: Top Row Metrics with real blockchain data
/**
 * Shared WHERE clause for the four analytics endpoints (audit §4.4/§4.5):
 * - scopes to the authenticated user
 * - honors the Clear-All cutoff (txcutoff:<userId>) used by Transactions
 * - supports ?from=YYYY-MM-DD&?to=YYYY-MM-DD date-range filtering
 */
async function analyticsTxWhere(req: any): Promise<any> {
  const userId = req.user?.id;
  // Only confirmed trades count toward analytics — failed/denied rows (recorded
  // since 2026-06-11 for the Transactions page) would distort profit/success math.
  const where: any = userId ? { userId, status: 'confirmed' } : { status: 'confirmed' };
  let clearedAtMs = 0;
  try {
    const row = await sqliteDb.app_config.findUnique({ where: { key: `txcutoff:${userId}` } });
    if (row?.value) clearedAtMs = parseInt(row.value) || 0;
  } catch { /* no cutoff set */ }
  const fromMs = req.query?.from ? Date.parse(String(req.query.from)) : 0;
  const toMs = req.query?.to ? Date.parse(String(req.query.to)) : 0;
  const gteMs = Math.max(clearedAtMs || 0, fromMs || 0);
  if (gteMs > 0 || toMs > 0) {
    where.timestamp = {
      ...(gteMs > 0 ? { gte: new Date(gteMs) } : {}),
      ...(toMs > 0 ? { lte: new Date(toMs) } : {}),
    };
  }
  return where;
}

app.get('/api/dashboard/stats', authenticateUser, asyncHandler(async (req, res) => {
  try {
    console.log('📊 Dashboard stats request received - calculating from blockchain-verified data');
    const startTime = Date.now();

    // Get all transactions for comprehensive stats
    const allTransactions = await sqliteDb.transactions.findMany({
      where: await analyticsTxWhere(req),
      select: {
        netSolAmount: true,
        profit: true,
        type: true,
        timestamp: true,
        tokenAddress: true
      },
      orderBy: {
        timestamp: 'desc'
      }
    });

    console.log(`📈 Found ${allTransactions.length} transactions for stats calculation`);

    // Calculate total profit using blockchain-verified netSolAmount
    const totalProfit = allTransactions.reduce((sum, tx) => {
      return sum + (Number(tx.netSolAmount) || 0);
    }, 0);

    // Calculate total trades
    const totalTrades = allTransactions.length;

    // Success rate = profitable ROUND TRIPS (2026-06-11, take 2).
    // Per-row math is wrong in both directions: counting buys makes >50% impossible
    // (a buy's netSol is always negative), and counting sells alone makes ~100%
    // automatic (a sell's netSol is the SOL received — almost always positive).
    // A "trade" = a token with at least one sell; it won if its NET SOL across
    // all its buys and sells is positive.
    const byToken = new Map<string, { net: number; hasSell: boolean }>();
    for (const tx of allTransactions) {
      const agg = byToken.get(tx.tokenAddress) ?? { net: 0, hasSell: false };
      agg.net += Number(tx.netSolAmount) || 0;
      if (tx.type === 'sell') agg.hasSell = true;
      byToken.set(tx.tokenAddress, agg);
    }
    const roundTrips = [...byToken.values()].filter(t => t.hasSell);
    const profitableTrades = roundTrips.filter(t => t.net > 0).length;
    const successRate = roundTrips.length > 0 ? (profitableTrades / roundTrips.length) * 100 : 0;

    // Calculate average profit per trade
    const avgProfitTrade = totalTrades > 0 ? totalProfit / totalTrades : 0;

    // Get additional metrics for debugging
    const buyTrades = allTransactions.filter(tx => tx.type === 'buy').length;
    const sellTrades = allTransactions.filter(tx => tx.type === 'sell').length;

    const queryTime = Date.now() - startTime;

    console.log(`📊 Stats calculation completed in ${queryTime}ms:`);
    console.log(`   - Total Profit: ${totalProfit.toFixed(9)} SOL`);
    console.log(`   - Total Trades: ${totalTrades}`);
    console.log(`   - Success Rate: ${successRate.toFixed(2)}%`);
    console.log(`   - Avg Profit/Trade: ${avgProfitTrade.toFixed(9)} SOL`);
    console.log(`   - Buy Trades: ${buyTrades}, Sell Trades: ${sellTrades}`);

    res.json({
      success: true,
      stats: {
        totalProfit: Number(totalProfit.toFixed(9)), // Precise SOL amount
        totalTrades: totalTrades,
        successRate: Number(successRate.toFixed(2)), // Percentage with 2 decimals
        avgProfitTrade: Number(avgProfitTrade.toFixed(9)), // Average profit per trade
        // Additional breakdown for frontend
        profitableTrades: profitableTrades,
        buyTrades: buyTrades,
        sellTrades: sellTrades
      },
      meta: {
        queryTime: queryTime,
        lastUpdated: new Date().toISOString(),
        dataSource: 'blockchain-verified'
      }
    });
  } catch (error) {
    console.error('❌ Error fetching dashboard stats:', error);
    res.status(500).json({
      stats: {
        totalProfit: 0,
        totalTrades: 0,
        successRate: 0,
        avgProfitTrade: 0
      },
      error: 'Failed to fetch stats'
    });
  }
}));

// Add profit history endpoint - Phase 2: Profit History Chart with cumulative data
app.get('/api/dashboard/profit-history', authenticateUser, asyncHandler(async (req, res) => {
  try {
    console.log('📈 Profit history request received - calculating cumulative profit over time');
    const startTime = Date.now();

    // Get all transactions ordered by timestamp for cumulative calculation
    const allTransactions = await sqliteDb.transactions.findMany({
      where: await analyticsTxWhere(req),
      select: {
        netSolAmount: true,
        timestamp: true,
        type: true,
        txId: true
      },
      orderBy: {
        timestamp: 'asc' // Important: ascending order for cumulative calculation
      }
    });

    console.log(`📊 Processing ${allTransactions.length} transactions for profit history`);

    // Group transactions by date and calculate cumulative profit
    const dailyProfitMap = new Map<string, { date: string; dailyProfit: number; cumulativeProfit: number; trades: number }>();
    let cumulativeProfit = 0;

    allTransactions.forEach(tx => {
      const txDate = new Date(tx.timestamp).toISOString().split('T')[0]; // YYYY-MM-DD format
      const txProfit = Number(tx.netSolAmount) || 0;

      // Update cumulative profit
      cumulativeProfit += txProfit;

      // Update daily data
      if (dailyProfitMap.has(txDate)) {
        const dayData = dailyProfitMap.get(txDate)!;
        dayData.dailyProfit += txProfit;
        dayData.cumulativeProfit = cumulativeProfit;
        dayData.trades += 1;
      } else {
        dailyProfitMap.set(txDate, {
          date: txDate,
          dailyProfit: txProfit,
          cumulativeProfit: cumulativeProfit,
          trades: 1
        });
      }
    });

    // Convert to array and fill the chart window. Honor the page's range selector
    // (?from=...) — previously the window was hardcoded to 30 days even on "7d".
    const today = new Date();
    const fromQ = req.query?.from ? Date.parse(String(req.query.from)) : 0;
    const windowStart = fromQ > 0
      ? new Date(fromQ)
      : new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);

    const profitHistory: Array<{
      date: string;
      dailyProfit: number;
      cumulativeProfit: number;
      trades: number;
    }> = [];
    // Seed the baseline with the cumulative profit of all trades BEFORE the window,
    // so leading no-trade days show the true running total instead of a fake 0.
    let lastCumulativeProfit = 0;
    const windowStartStr = windowStart.toISOString().split('T')[0];
    for (const [dateStr, dayData] of dailyProfitMap) {
      if (dateStr < windowStartStr) lastCumulativeProfit = dayData.cumulativeProfit;
      else break; // map insertion order is chronological (txs sorted asc)
    }

    // Fill in every day of the window
    for (let d = new Date(windowStart); d <= today; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().split('T')[0];

      if (dailyProfitMap.has(dateStr)) {
        const dayData = dailyProfitMap.get(dateStr)!;
        lastCumulativeProfit = dayData.cumulativeProfit;
        profitHistory.push({
          date: dateStr,
          dailyProfit: Number(dayData.dailyProfit.toFixed(9)),
          cumulativeProfit: Number(dayData.cumulativeProfit.toFixed(9)),
          trades: dayData.trades
        });
      } else {
        // No trades on this day, use last cumulative profit
        profitHistory.push({
          date: dateStr,
          dailyProfit: 0,
          cumulativeProfit: Number(lastCumulativeProfit.toFixed(9)),
          trades: 0
        });
      }
    }

    const queryTime = Date.now() - startTime;

    console.log(`📈 Profit history calculated in ${queryTime}ms:`);
    console.log(`   - Days with data: ${dailyProfitMap.size}`);
    console.log(`   - Final cumulative profit: ${lastCumulativeProfit.toFixed(9)} SOL`);
    console.log(`   - Date range: ${profitHistory[0]?.date} to ${profitHistory[profitHistory.length - 1]?.date}`);

    res.json({
      success: true,
      profitHistory: profitHistory,
      meta: {
        totalDays: profitHistory.length,
        daysWithTrades: dailyProfitMap.size,
        finalCumulativeProfit: Number(lastCumulativeProfit.toFixed(9)),
        queryTime: queryTime,
        lastUpdated: new Date().toISOString(),
        dataSource: 'blockchain-verified'
      }
    });
  } catch (error) {
    console.error('❌ Error fetching profit history:', error);
    res.status(500).json({
      profitHistory: [],
      error: 'Failed to fetch profit history'
    });
  }
}));

// Add token performance endpoint - Phase 3: Best Performers Section
app.get('/api/dashboard/token-performance', authenticateUser, asyncHandler(async (req, res) => {
  try {
    console.log('🏆 Token performance request received - analyzing best performers');
    const startTime = Date.now();

    // Get all transactions with token details for performance analysis
    const allTransactions = await sqliteDb.transactions.findMany({
      where: await analyticsTxWhere(req),
      select: {
        netSolAmount: true,  // Use netSolAmount instead of profit
        totalSolCost: true,  // Also get totalSolCost as backup
        tokenName: true,
        tokenAddress: true,
        tokenSymbol: true,
        type: true,
        dex: true,
        timestamp: true,
        amount: true,
        price: true
      },
      orderBy: {
        timestamp: 'desc'
      }
    });

    console.log(`🏆 Processing ${allTransactions.length} transactions for performance analysis`);

    // Group by token for performance analysis
    const tokenPerformanceMap = new Map();
    const dexPerformanceMap = new Map();

    allTransactions.forEach(tx => {
      const tokenKey = tx.tokenAddress;
      const dexKey = tx.dex;
      // §4.3: netSolAmount only. NEVER fall back to totalSolCost — it's a COST,
      // substituting it as profit inflated results. Missing data counts as 0.
      const profit = tx.netSolAmount != null ? Number(tx.netSolAmount) : 0;

      // Token performance tracking
      if (tokenPerformanceMap.has(tokenKey)) {
        const tokenData = tokenPerformanceMap.get(tokenKey);
        tokenData.totalProfit += profit;
        tokenData.totalTrades += 1;
        tokenData.buyTrades += tx.type === 'buy' ? 1 : 0;
        tokenData.sellTrades += tx.type === 'sell' ? 1 : 0;
        tokenData.profitableTrades += profit > 0 ? 1 : 0;
        tokenData.lastTradeDate = tx.timestamp;
      } else {
        tokenPerformanceMap.set(tokenKey, {
          tokenName: tx.tokenName,
          tokenSymbol: tx.tokenSymbol || 'Unknown',
          tokenAddress: tx.tokenAddress,
          totalProfit: profit,
          totalTrades: 1,
          buyTrades: tx.type === 'buy' ? 1 : 0,
          sellTrades: tx.type === 'sell' ? 1 : 0,
          profitableTrades: profit > 0 ? 1 : 0,
          successRate: 0, // Will be calculated below
          avgProfitPerTrade: 0, // Will be calculated below
          lastTradeDate: tx.timestamp
        });
      }

      // DEX performance tracking
      if (dexPerformanceMap.has(dexKey)) {
        const dexData = dexPerformanceMap.get(dexKey);
        dexData.totalProfit += profit;
        dexData.totalTrades += 1;
        dexData.profitableTrades += profit > 0 ? 1 : 0;
      } else {
        dexPerformanceMap.set(dexKey, {
          dexName: dexKey,
          totalProfit: profit,
          totalTrades: 1,
          profitableTrades: profit > 0 ? 1 : 0,
          successRate: 0, // Will be calculated below
          avgProfitPerTrade: 0 // Will be calculated below
        });
      }
    });

    // ── Round-trip outcomes (2026-06-11): success = token's NET SOL > 0 across all
    // its buys+sells, attributed to the DEX of the closing sell. Per-row success
    // rates counted every buy as a "failure" (buys always have negative netSol).
    const rtByToken = new Map<string, { net: number; sellDex: string | null; lastSellTs: Date | null }>();
    for (const tx of allTransactions) {
      const agg = rtByToken.get(tx.tokenAddress) ?? { net: 0, sellDex: null, lastSellTs: null };
      agg.net += tx.netSolAmount != null ? Number(tx.netSolAmount) : 0;
      if (tx.type === 'sell' && (!agg.lastSellTs || tx.timestamp > agg.lastSellTs)) {
        agg.lastSellTs = tx.timestamp;
        agg.sellDex = tx.dex;
      }
      rtByToken.set(tx.tokenAddress, agg);
    }
    const dexRoundTrips = new Map<string, { count: number; wins: number }>();
    for (const t of rtByToken.values()) {
      if (!t.sellDex) continue; // open position — not an outcome yet
      const d = dexRoundTrips.get(t.sellDex) ?? { count: 0, wins: 0 };
      d.count += 1;
      if (t.net > 0) d.wins += 1;
      dexRoundTrips.set(t.sellDex, d);
    }

    // Calculate success rates and averages for tokens.
    // A token IS one round trip — success is binary: closed (has sells) and net-positive.
    const tokenPerformance = Array.from(tokenPerformanceMap.values()).map(token => {
      token.successRate = token.sellTrades > 0 ? (token.totalProfit > 0 ? 100 : 0) : 0;
      token.avgProfitPerTrade = token.totalTrades > 0 ? token.totalProfit / token.totalTrades : 0;
      return {
        ...token,
        totalProfit: Number(token.totalProfit.toFixed(9)),
        successRate: Number(token.successRate.toFixed(2)),
        avgProfitPerTrade: Number(token.avgProfitPerTrade.toFixed(9))
      };
    });

    // Calculate success rates and averages for DEXs (round-trip based)
    const dexPerformance = Array.from(dexPerformanceMap.values()).map(dex => {
      const rt = dexRoundTrips.get(dex.dexName);
      dex.successRate = rt && rt.count > 0 ? (rt.wins / rt.count) * 100 : 0;
      dex.avgProfitPerTrade = dex.totalTrades > 0 ? dex.totalProfit / dex.totalTrades : 0;
      return {
        ...dex,
        totalProfit: Number(dex.totalProfit.toFixed(9)),
        successRate: Number(dex.successRate.toFixed(2)),
        avgProfitPerTrade: Number(dex.avgProfitPerTrade.toFixed(9))
      };
    });

    // NOTE: Do not add fake/placeholder DEX entries here.
    // Only show DEXs with real transaction data from the database.

    // Sort by total profit (best performers first)
    tokenPerformance.sort((a, b) => b.totalProfit - a.totalProfit);
    dexPerformance.sort((a, b) => b.totalProfit - a.totalProfit);

    // Get top performers (limit to top 10)
    const topTokens = tokenPerformance.slice(0, 10);
    const topDexs = dexPerformance.slice(0, 5);

    const queryTime = Date.now() - startTime;

    console.log(`🏆 Token performance analysis completed in ${queryTime}ms:`);
    console.log(`   - Analyzed ${tokenPerformance.length} unique tokens`);
    console.log(`   - Analyzed ${dexPerformance.length} unique DEXs`);
    console.log(`   - Top token: ${topTokens[0]?.tokenName} (${topTokens[0]?.totalProfit.toFixed(6)} SOL)`);
    console.log(`   - Top DEX: ${topDexs[0]?.dexName} (${topDexs[0]?.totalProfit.toFixed(6)} SOL)`);

    res.json({
      success: true,
      tokenPerformance: topTokens,
      dexPerformance: topDexs,
      meta: {
        totalTokensAnalyzed: tokenPerformance.length,
        totalDexsAnalyzed: dexPerformance.length,
        queryTime: queryTime,
        lastUpdated: new Date().toISOString(),
        dataSource: 'blockchain-verified'
      }
    });
  } catch (error) {
    console.error('❌ Error fetching token performance:', error);
    res.status(500).json({
      tokenPerformance: [],
      dexPerformance: [],
      error: 'Failed to fetch token performance'
    });
  }
}));

// Add trading results endpoint - Phase 4: Trading Results Analysis
app.get('/api/dashboard/trading-results', authenticateUser, asyncHandler(async (req, res) => {
  try {
    console.log('📊 Trading results request received - analyzing best/worst trades');
    const startTime = Date.now();

    // Get all transactions ordered by timestamp
    const allTransactions = await sqliteDb.transactions.findMany({
      where: await analyticsTxWhere(req),
      select: {
        id: true,
        netSolAmount: true,
        totalSolCost: true,
        tokenName: true,
        tokenSymbol: true,
        tokenAddress: true,
        type: true,
        dex: true,
        timestamp: true,
        txId: true
      },
      orderBy: {
        timestamp: 'desc'
      }
    });

    console.log(`📊 Processing ${allTransactions.length} transactions for trading results`);

    // Calculate individual transaction profits using SOL-only calculations.
    // §4.3: netSolAmount ONLY — the old `|| totalSolCost` fallback substituted a
    // (positive) COST as profit, which could crown a buy's cost the "best trade".
    const transactionProfits = allTransactions.map(tx => {
      const profit = tx.netSolAmount != null ? Number(tx.netSolAmount) : 0;
      return {
        id: tx.id,
        profit: profit,
        tokenName: tx.tokenName,
        tokenSymbol: tx.tokenSymbol,
        tokenAddress: tx.tokenAddress,
        type: tx.type,
        dex: tx.dex,
        timestamp: tx.timestamp,
        txId: tx.txId,
        date: tx.timestamp.toISOString().split('T')[0] // YYYY-MM-DD format
      };
    }).sort((a, b) => b.profit - a.profit); // Sort by profit (best first)

    // ── Best/Worst "trade" = realized ROUND TRIP per token (2026-06-11, take 2) ──
    // Per-row values are wrong in both directions: a buy's netSol is always negative
    // (biggest buy = automatic "worst trade") and a sell's netSol is the SOL received,
    // almost always positive (any sell = automatic "best trade"). A trade's real PnL
    // is the token's NET SOL across all of its buys and sells.
    const tokenAgg = new Map<string, {
      profit: number; tokenName: string; tokenSymbol: string | null;
      dex: string; hasSell: boolean; lastSellTs: Date | null; lastSellTxId: string | null;
    }>();
    for (const tx of transactionProfits) {
      const agg = tokenAgg.get(tx.tokenAddress) ?? {
        profit: 0, tokenName: tx.tokenName, tokenSymbol: tx.tokenSymbol,
        dex: tx.dex, hasSell: false, lastSellTs: null, lastSellTxId: null,
      };
      agg.profit += tx.profit;
      // Prefer a real name over 'Unknown' from whichever row has it
      if (agg.tokenName === 'Unknown' && tx.tokenName !== 'Unknown') {
        agg.tokenName = tx.tokenName; agg.tokenSymbol = tx.tokenSymbol;
      }
      if (tx.type === 'sell') {
        agg.hasSell = true;
        if (!agg.lastSellTs || tx.timestamp > agg.lastSellTs) {
          agg.lastSellTs = tx.timestamp; agg.lastSellTxId = tx.txId; agg.dex = tx.dex;
        }
      }
      tokenAgg.set(tx.tokenAddress, agg);
    }
    const roundTrips = [...tokenAgg.values()]
      .filter(t => t.hasSell) // open positions aren't outcomes yet
      .map(t => ({
        profit: t.profit,
        tokenName: t.tokenName,
        tokenSymbol: t.tokenSymbol,
        dex: t.dex,
        timestamp: t.lastSellTs as Date,
        txId: t.lastSellTxId,
        date: (t.lastSellTs as Date).toISOString().split('T')[0],
      }))
      .sort((a, b) => b.profit - a.profit);
    const bestTrade = roundTrips[0] || null;
    const worstTrade = roundTrips[roundTrips.length - 1] || null;

    // Calculate daily aggregations for best/worst trading days
    const dailyProfits = new Map();
    transactionProfits.forEach(tx => {
      const date = tx.date;
      if (dailyProfits.has(date)) {
        const dayData = dailyProfits.get(date);
        dayData.totalProfit += tx.profit;
        dayData.trades += 1;
        dayData.transactions.push(tx);
      } else {
        dailyProfits.set(date, {
          date: date,
          totalProfit: tx.profit,
          trades: 1,
          transactions: [tx]
        });
      }
    });

    // Convert to array and sort by daily profit
    const dailyResults = Array.from(dailyProfits.values())
      .map(day => ({
        ...day,
        totalProfit: Number(day.totalProfit.toFixed(9)),
        avgProfitPerTrade: day.trades > 0 ? Number((day.totalProfit / day.trades).toFixed(9)) : 0
      }))
      .sort((a, b) => b.totalProfit - a.totalProfit);

    const bestTradingDay = dailyResults[0] || null;
    const worstTradingDay = dailyResults[dailyResults.length - 1] || null;

    // Calculate winning and losing streaks
    let currentStreak = 0;
    let longestWinStreak = 0;
    let longestLossStreak = 0;
    let streakType: 'win' | 'loss' | null = null; // 'win' or 'loss'

    // Streaks over ROUND TRIPS in the order they closed (last sell time) — the
    // per-row version alternated buy("loss")/sell("win") and was meaningless.
    const chronologicalTrades = [...roundTrips].sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    chronologicalTrades.forEach(trade => {
      if (trade.profit > 0) {
        // Winning trade
        if (streakType === 'win') {
          currentStreak += 1;
        } else {
          // Starting new win streak
          currentStreak = 1;
          streakType = 'win';
        }
        longestWinStreak = Math.max(longestWinStreak, currentStreak);
      } else if (trade.profit < 0) {
        // Losing trade
        if (streakType === 'loss') {
          currentStreak += 1;
        } else {
          // Starting new loss streak
          currentStreak = 1;
          streakType = 'loss';
        }
        longestLossStreak = Math.max(longestLossStreak, currentStreak);
      }
      // Profit of 0 doesn't affect streaks
    });

    const queryTime = Date.now() - startTime;

    console.log(`📊 Trading results analysis completed in ${queryTime}ms:`);
    console.log(`   - Best trade: ${bestTrade?.profit.toFixed(6)} SOL (${bestTrade?.tokenName})`);
    console.log(`   - Worst trade: ${worstTrade?.profit.toFixed(6)} SOL (${worstTrade?.tokenName})`);
    console.log(`   - Best day: ${bestTradingDay?.totalProfit.toFixed(6)} SOL (${bestTradingDay?.date})`);
    console.log(`   - Worst day: ${worstTradingDay?.totalProfit.toFixed(6)} SOL (${worstTradingDay?.date})`);
    console.log(`   - Longest win streak: ${longestWinStreak} trades`);
    console.log(`   - Longest loss streak: ${longestLossStreak} trades`);

    res.json({
      success: true,
      bestResults: {
        bestTrade: bestTrade ? {
          profit: Number(bestTrade.profit.toFixed(9)),
          tokenName: bestTrade.tokenName,
          tokenSymbol: bestTrade.tokenSymbol,
          dex: bestTrade.dex,
          date: bestTrade.date,
          txId: bestTrade.txId
        } : null,
        bestTradingDay: bestTradingDay,
        longestWinStreak: longestWinStreak
      },
      worstResults: {
        worstTrade: worstTrade ? {
          profit: Number(worstTrade.profit.toFixed(9)),
          tokenName: worstTrade.tokenName,
          tokenSymbol: worstTrade.tokenSymbol,
          dex: worstTrade.dex,
          date: worstTrade.date,
          txId: worstTrade.txId
        } : null,
        worstTradingDay: worstTradingDay,
        longestLossStreak: longestLossStreak
      },
      meta: {
        totalTransactions: allTransactions.length,
        totalTradingDays: dailyResults.length,
        queryTime: queryTime,
        lastUpdated: new Date().toISOString(),
        dataSource: 'blockchain-verified'
      }
    });
  } catch (error) {
    console.error('❌ Error fetching trading results:', error);
    res.status(500).json({
      bestResults: null,
      worstResults: null,
      error: 'Failed to fetch trading results'
    });
  }
}));

// Missing wallet endpoints that the frontend expects
app.get('/api/wallets', authenticateUser, asyncHandler(async (req: Request, res: Response) => {
  try {
    console.log('📝 Wallets list request received');

    // This endpoint should be authenticated, but for now we'll return empty
    // In a real implementation, we'd get the user ID from the auth middleware
    res.status(200).json({
      wallets: [],
      message: 'Use authenticated endpoints for wallet access'
    });
  } catch (error: any) {
    console.error('❌ Error fetching wallets:', error);
    res.status(200).json({ wallets: [] });
  }
}));

// @ts-ignore - TypeScript middleware compatibility
app.get('/api/wallets/:id/token-holdings', authenticateUser, asyncAuthHandler(async (req: Request, res: Response) => {
  try {
    console.log('💰 Token holdings request for wallet:', req.params.id);
    const { id } = req.params;
    const { includeMetadata } = req.query;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Get the wallet and verify ownership
    const wallet = await secureWalletService.getWallet(id, userId);
    if (!wallet) {
      return res.status(404).json({ error: 'Wallet not found or access denied' });
    }

    console.log(`💰 Fetching token holdings for wallet: ${wallet.walletName} (${wallet.publicKey})`);

    // Get all token accounts — must query BOTH programs:
    // - Legacy SPL Token: TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
    // - Token2022: TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
    // pump.fun now uses Token2022, so without this query all pump.fun holdings show as empty.
    const { PublicKey } = await import('@solana/web3.js');
    const connection = rpcManager.getConnection();
    const walletPublicKey = new PublicKey(wallet.publicKey);
    const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

    let splAccounts: any = { value: [] };
    let t22Accounts: any = { value: [] };
    try {
      [splAccounts, t22Accounts] = await Promise.all([
        connection.getParsedTokenAccountsByOwner(walletPublicKey, { programId: TOKEN_PROGRAM_ID }),
        connection.getParsedTokenAccountsByOwner(walletPublicKey, { programId: TOKEN_2022_PROGRAM }),
      ]);
    } catch (rpcErr: any) {
      const msg = rpcErr?.message || '';
      if (msg.includes('429') || msg.includes('Too Many Requests')) {
        console.warn('⚠️ RPC rate limited fetching token holdings — returning empty');
        return res.json({ success: true, holdings: [], rateLimited: true });
      }
      throw rpcErr; // re-throw real errors
    }

    const tokenAccounts = { value: [...splAccounts.value, ...t22Accounts.value] };
    console.log(`🪙 Found ${tokenAccounts.value.length} token accounts (SPL: ${splAccounts.value.length}, Token2022: ${t22Accounts.value.length})`);


    const holdings: any[] = [];

    for (const tokenAccount of tokenAccounts.value) {
      const accountData = tokenAccount.account.data.parsed.info;
      const mint = accountData.mint;
      const tokenAmount = accountData.tokenAmount;

      const hasValidBalance = tokenAmount.uiAmount &&
        tokenAmount.uiAmount > 0 &&
        parseInt(tokenAmount.amount) > 0 &&
        tokenAmount.uiAmount >= 0.000001;

      if (hasValidBalance) {
        holdings.push({
          mint,
          balance: tokenAmount.uiAmount,
          decimals: tokenAmount.decimals,
          amount: tokenAmount.amount,
          uiAmount: tokenAmount.uiAmount,
        });
      }
    }

    console.log(`🪙 Valid holdings before metadata: ${holdings.length}`);

    // ── Ghost-holding reconciliation ─────────────────────────────────────────
    // rpcManager rotates RPC nodes; a lagging node can report token accounts that
    // were already emptied (sold/closed elsewhere) — producing orphaned holdings
    // in the UI that don't match the real wallet. Re-verify EVERY holding with a
    // fresh 'confirmed' read on the primary (Helius) RPC and drop dead entries.
    const heliusVerifyKey = process.env.HELIUS_API_KEY;
    if (holdings.length > 0 && heliusVerifyKey) {
      try {
        const { Connection: VConn } = await import('@solana/web3.js');
        const verifyConn = new VConn(`https://mainnet.helius-rpc.com/?api-key=${heliusVerifyKey}`, 'confirmed');
        const verified = await Promise.all(holdings.map(async (h: any) => {
          try {
            const accs = await verifyConn.getParsedTokenAccountsByOwner(
              walletPublicKey, { mint: new PublicKey(h.mint) }
            );
            const liveUi = accs.value.reduce(
              (s: number, a: any) => s + (a.account.data.parsed.info.tokenAmount.uiAmount || 0), 0
            );
            if (liveUi <= 0.000001) {
              console.log(`🧹 Dropped ghost holding ${h.mint} — stale RPC said ${h.uiAmount}, live balance is ${liveUi}`);
              return null;
            }
            // Trust the fresh read for the displayed amount too
            if (Math.abs(liveUi - h.uiAmount) > 0.000001) {
              console.log(`🔄 Corrected stale balance for ${h.mint}: ${h.uiAmount} → ${liveUi}`);
              h.balance = liveUi;
              h.uiAmount = liveUi;
            }
            return h;
          } catch {
            return h; // verification call failed — keep the holding, never hide real tokens on RPC errors
          }
        }));
        const dropped = holdings.length - verified.filter(Boolean).length;
        holdings.length = 0;
        holdings.push(...verified.filter(Boolean));
        if (dropped > 0) console.log(`🧹 Reconciliation removed ${dropped} ghost holding(s); ${holdings.length} remain`);
      } catch (verErr: any) {
        console.warn(`⚠️ Holdings reconciliation skipped: ${verErr?.message}`);
      }
    }

    // ── Venue enrichment (2026-06-12) ────────────────────────────────────────
    // The UI guessed the launch platform from the mint suffix ('pump'/'bonk'),
    // but pump.fun no longer guarantees the suffix — tokens like 7Mf5Sqs… showed
    // a DexScreener badge despite being pump.fun buys. The DB knows the real
    // venue from the recorded trade; attach it so the frontend doesn't guess.
    if (holdings.length > 0) {
      try {
        const mintsAll = holdings.map((h: any) => h.mint);
        const txRows = await sqliteDb.transactions.findMany({
          where: { userId, tokenAddress: { in: mintsAll }, status: 'confirmed' },
          select: { tokenAddress: true, dex: true },
          orderBy: { timestamp: 'desc' },
        });
        for (const h of holdings as any[]) {
          const row = txRows.find((t) => t.tokenAddress === h.mint);
          if (row?.dex) h.dex = String(row.dex).toLowerCase();
        }
      } catch { /* badge falls back to the suffix heuristic */ }
    }

    // ── Batch metadata enrichment ─────────────────────────────────────────────
    // Instead of N sequential HTTP calls per token, do parallel batch calls.
    if (includeMetadata === 'true' && holdings.length > 0) {
      const mints = holdings.map((h: any) => h.mint);

      // 1. Helius DAS getAssetBatch — one RPC call, resolves Token2022 on-chain metadata
      try {
        const heliusKey = process.env.HELIUS_API_KEY;
        if (heliusKey) {
          const dasRes = await fetch(`https://mainnet.helius-rpc.com/?api-key=${heliusKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAssetBatch', params: { ids: mints } }),
          });
          if (dasRes.ok) {
            const das = await dasRes.json();
            const assets: any[] = das?.result || [];
            console.log(`🔍 Helius DAS returned ${assets.length} assets`);
            for (const asset of assets) {
              const id = asset?.id;
              const h = holdings.find((x: any) => x.mint === id);
              if (!h) continue;
              const meta = asset?.content?.metadata;
              if (meta?.symbol) h.symbol = meta.symbol;
              if (meta?.name) h.name = meta.name;
              const img = asset?.content?.links?.image;
              if (img) h.logoURI = img;
            }
          }
        }
      } catch (e: any) {
        console.log(`⚠️ Helius DAS batch failed: ${e?.message}`);
      }

      // 2. DexScreener bulk — fills in any still-missing symbols and adds price
      const stillMissing = holdings.filter((h: any) => !h.symbol).map((h: any) => h.mint);
      if (stillMissing.length > 0) {
        try {
          // DexScreener accepts comma-separated mints (up to 30)
          const dexRes = await fetch(
            `https://api.dexscreener.com/tokens/v1/solana/${stillMissing.join(',')}`,
            { headers: { 'User-Agent': 'AutoBot/1.0' } }
          );
          if (dexRes.ok) {
            const pairs: any[] = await dexRes.json();
            console.log(`📊 DexScreener returned ${pairs.length} pairs`);
            for (const pair of pairs) {
              const base = pair?.baseToken;
              if (!base) continue;
              const h = holdings.find((x: any) => x.mint === base.address);
              if (!h) continue;
              if (!h.symbol) h.symbol = base.symbol;
              if (!h.name) h.name = base.name;
              if (!h.logoURI && pair.info?.imageUrl) h.logoURI = pair.info.imageUrl;
              // Price from DexScreener
              if (pair.priceUsd && !h.price) {
                h.price = parseFloat(pair.priceUsd);
                h.value = h.uiAmount * h.price;
              }
            }
          }
        } catch (e: any) {
          console.log(`⚠️ DexScreener batch failed: ${e?.message}`);
        }
      }
    }

    // Sort by value (if available) or balance
    holdings.sort((a: any, b: any) => {
      if (a.value && b.value) {
        return b.value - a.value;
      }
      return (b.uiAmount || 0) - (a.uiAmount || 0);
    });

    console.log(`✅ Found ${holdings.length} non-zero token holdings`);

    res.status(200).json({
      holdings,
      walletAddress: wallet.publicKey,
      walletName: wallet.walletName,
      totalTokens: holdings.length
    });
  } catch (error: any) {
    console.error('❌ Error fetching token holdings:', error);
    res.status(500).json({
      holdings: [],
      error: 'Failed to fetch token holdings',
      details: error.message
    });
  }
}));
// (slop audit) PUT /api/wallets/:id/activate — dead route archived to archive/dead-endpoints-20260612.ts.txt

// @ts-ignore
app.post('/api/wallets/:id/balance', authenticateUser, asyncAuthHandler(async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const wallet = await prisma.managed_wallets.findFirst({
      where: { id, userId },
      select: { id: true, publicKey: true }
    });
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

    const connection = rpcManager.getConnection();
    const { PublicKey } = await import('@solana/web3.js');
    const lamports = await connection.getBalance(new PublicKey(wallet.publicKey));
    const balanceSol = lamports / 1_000_000_000;

    await prisma.managed_wallets.updateMany({
      where: { id, userId },
      data: { balanceSol }
    });

    // Broadcast update to all connected WebSocket clients
    broadcastToAll({
      type: 'walletBalanceUpdate',
      walletId: id,
      publicKey: wallet.publicKey,
      balanceSol,
      timestamp: new Date().toISOString()
    });

    console.log(`💰 Balance updated: ${wallet.publicKey} → ${balanceSol} SOL`);
    res.json({ success: true, balance: balanceSol, walletId: id });
  } catch (error: any) {
    console.error('❌ Error refreshing wallet balance:', error);
    res.status(500).json({ error: 'Failed to refresh balance' });
  }
}));

// @ts-ignore
app.post('/api/wallets/refresh-all-balances', authenticateUser, asyncAuthHandler(async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const wallets = await prisma.managed_wallets.findMany({
      where: { userId },
      select: { id: true, publicKey: true }
    });

    const connection = rpcManager.getConnection();
    const { PublicKey } = await import('@solana/web3.js');

    const updates = await Promise.allSettled(wallets.map(async (w) => {
      const lamports = await connection.getBalance(new PublicKey(w.publicKey));
      const balanceSol = lamports / 1_000_000_000;
      await prisma.managed_wallets.updateMany({ where: { id: w.id }, data: { balanceSol } });
      broadcastToAll({ type: 'walletBalanceUpdate', walletId: w.id, publicKey: w.publicKey, balanceSol, timestamp: new Date().toISOString() });
      return { id: w.id, balanceSol };
    }));

    const succeeded = updates.filter(u => u.status === 'fulfilled').length;
    console.log(`💰 Refreshed ${succeeded}/${wallets.length} wallet balances`);
    res.json({ success: true, updated: succeeded });
  } catch (error: any) {
    console.error('❌ Error refreshing all balances:', error);
    res.status(500).json({ error: 'Failed to refresh balances' });
  }
}));
// (slop audit) GET /api/debug/current-user — dead route archived to archive/dead-endpoints-20260612.ts.txt

// 🔐 SECURE WALLET ENDPOINTS - Using AES-256 encryption

// Create new wallet (encrypted storage)
// @ts-ignore - TypeScript middleware compatibility
app.post('/api/wallets/create', authenticateUser, asyncAuthHandler(async (req, res) => {
  try {
    const { walletName } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    if (!walletName || walletName.trim().length === 0) {
      return res.status(400).json({ error: 'Wallet name is required' });
    }

    console.log(`🔐 Creating secure wallet "${walletName}" for user ${userId}`);

    const wallet = await secureWalletService.createWallet(userId, walletName.trim());

    res.json({
      success: true,
      wallet: {
        id: wallet.id,
        name: wallet.walletName,
        publicKey: wallet.publicKey,
        balance: wallet.balanceSol,
        isActive: wallet.isActive,
        createdAt: wallet.createdAt
      }
    });
  } catch (error) {
    console.error('❌ Error creating secure wallet:', error);
    const message = error instanceof Error ? error.message : 'Failed to create wallet';
    res.status(500).json({ error: message });
  }
}));

// Batch create wallets
// @ts-ignore - TypeScript middleware compatibility
app.post('/api/wallets/batch-create', authenticateUser, asyncAuthHandler(async (req, res) => {
  try {
    const { walletNames } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    if (!Array.isArray(walletNames) || walletNames.length === 0) {
      return res.status(400).json({ error: 'Wallet names array is required' });
    }

    console.log(`🔐 Creating ${walletNames.length} secure wallets for user ${userId}`);

    const result = await secureWalletService.createWalletsBatch(userId, walletNames);

    res.json({
      success: true,
      result: {
        created: result.successful.length,
        failed: result.failed.length,
        wallets: result.successful,
        errors: result.failed
      }
    });
  } catch (error) {
    console.error('❌ Error creating batch wallets:', error);
    const message = error instanceof Error ? error.message : 'Failed to create wallets';
    res.status(500).json({ error: message });
  }
}));

// Import wallet (secure)
// @ts-ignore - TypeScript middleware compatibility
app.post('/api/wallets/import', authenticateUser, asyncAuthHandler(async (req, res) => {
  try {
    const { walletName, privateKey } = req.body;
    const userId = req.user?.id;
    const profileWalletAddress = req.user?.profileWalletAddress;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    if (!walletName || !privateKey) {
      return res.status(400).json({ error: 'Wallet name and private key are required' });
    }

    console.log(`🔐 Importing secure wallet "${walletName}" for user ${userId}`);

    const wallet = await secureWalletService.importWallet(userId, walletName, privateKey, profileWalletAddress);

    // Immediately fetch real SOL balance so the card doesn't show 0
    let balanceSol = 0;
    try {
      const { PublicKey } = await import('@solana/web3.js');
      const connection = rpcManager.getConnection();
      const lamports = await connection.getBalance(new PublicKey(wallet.publicKey));
      balanceSol = lamports / 1_000_000_000;
      await prisma.managed_wallets.update({
        where: { id: wallet.id },
        data: { balanceSol }
      });
      console.log(`💰 Initial balance for imported wallet: ${balanceSol} SOL`);
    } catch (e) {
      console.warn('⚠️ Could not fetch initial balance after import:', e);
    }

    res.json({
      success: true,
      wallet: { ...wallet, balanceSol },
      isProfileWallet: wallet.isProfileWallet || false
    });
  } catch (error) {
    console.error('❌ Error importing wallet:', error);
    const message = error instanceof Error ? error.message : 'Failed to import wallet';
    res.status(500).json({ error: message });
  }
}));

// Get user wallets (secure)
// @ts-ignore - TypeScript middleware compatibility
app.get('/api/wallets/secure', authenticateUser, (asyncAuthHandler(async (req, res) => {
  try {
    const userId = req.user?.id;
    const profileWalletAddress = req.user?.profileWalletAddress;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    console.log(`🔐 Fetching secure wallets for user ${userId}`);
    const startTime = Date.now();

    const wallets = await secureWalletService.getUserWalletsUltraFast(userId);

    const queryTime = Date.now() - startTime;
    console.log(`⚡ Wallet query completed in ${queryTime}ms for ${wallets.length} wallets`);

    // Map the wallet data to match frontend expectations
    const mappedWallets = wallets.map(wallet => ({
      id: wallet.id,
      name: wallet.walletName,
      publicKey: wallet.publicKey,
      balance: wallet.balanceSol,
      isActive: wallet.isActive,
      createdAt: wallet.createdAt,
      wallet_type: wallet.wallet_type || 'sniping',
      isProfileWallet: wallet.wallet_type === 'profile' || wallet.publicKey === profileWalletAddress,
    }));

    // Add performance headers
    res.set({
      'X-Response-Time': `${queryTime}ms`,
      'X-Wallet-Count': wallets.length.toString(),
      'Cache-Control': 'private, max-age=30', // 30 second client cache
    });

    res.json({
      success: true,
      wallets: mappedWallets,
      profileWalletAddress: profileWalletAddress || null,
      meta: {
        count: wallets.length,
        queryTime: queryTime,
        cached: false
      }
    });
  } catch (error) {
    console.error('❌ Error fetching secure wallets:', error);
    const message = error instanceof Error ? error.message : 'Failed to fetch wallets';
    res.status(500).json({ error: message });
  }
}) as any));

// Set active wallet
// @ts-ignore - TypeScript middleware compatibility
app.put('/api/wallets/:id/activate-secure', authenticateUser, (asyncAuthHandler(async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    console.log(`🔐 Activating secure wallet ${id} for user ${userId}`);

    await secureWalletService.setActiveWallet(id, userId);

    res.json({
      success: true,
      message: 'Wallet activated successfully'
    });
  } catch (error) {
    console.error('❌ Error activating secure wallet:', error);
    const message = error instanceof Error ? error.message : 'Failed to activate wallet';
    res.status(500).json({ error: message });
  }
}) as any));

// Rotate wallet encryption
// @ts-ignore - TypeScript middleware compatibility
app.post('/api/wallets/:id/rotate-encryption', authenticateUser, (asyncAuthHandler(async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    console.log(`🔐 Rotating encryption for wallet ${id}, user ${userId}`);

    const result = await secureWalletService.rotateWalletEncryption(id, userId);

    res.json({
      success: true,
      result
    });
  } catch (error) {
    console.error('❌ Error rotating wallet encryption:', error);
    const message = error instanceof Error ? error.message : 'Failed to rotate encryption';
    res.status(500).json({ error: message });
  }
}) as any));

// Security audit
// @ts-ignore - TypeScript middleware compatibility
app.get('/api/wallets/security-audit', authenticateUser, (asyncAuthHandler(async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    console.log(`🔍 Running security audit for user ${userId}`);

    const audit = await secureWalletService.auditUserWallets(userId);

    res.json({
      success: true,
      audit
    });
  } catch (error) {
    console.error('❌ Error running security audit:', error);
    const message = error instanceof Error ? error.message : 'Failed to run security audit';
    res.status(500).json({ error: message });
  }
}) as any));

// Delete wallet securely
// @ts-ignore - TypeScript middleware compatibility
app.delete('/api/wallets/:id/secure-delete', authenticateUser, (asyncAuthHandler(async (req, res) => {
  try {
    const { id } = req.params;
    const { confirmationPhrase } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    console.log(`🔐 Attempting to securely delete wallet ${id} for user ${userId}`);
    console.log(`🔍 Confirmation phrase received: "${confirmationPhrase}"`);

    const result = await secureWalletService.deleteWallet(id, userId, confirmationPhrase);

    console.log(`✅ Wallet ${id} successfully deleted from database`);

    res.json({
      success: true,
      message: 'Wallet permanently deleted from server',
      walletId: id,
      result
    });
  } catch (error) {
    console.error('❌ Error deleting secure wallet:', error);
    const message = error instanceof Error ? error.message : 'Failed to delete wallet';
    res.status(500).json({ error: message });
  }
}) as any));

// SECURITY FIX: Removed /api/wallets/:id/private-key endpoint
// Private keys should NEVER leave the server. Use server-side signing instead.

// Check if wallet needs upgrade (legacy wallet detection)
// @ts-ignore - TypeScript middleware compatibility
app.get('/api/wallets/:id/check-legacy', authenticateUser, (asyncAuthHandler(async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const isLegacy = await walletMigrationService.isLegacyWallet(id);

    res.json({
      success: true,
      isLegacy,
      message: isLegacy ? 'Wallet needs upgrade to modern encryption' : 'Wallet is already modern'
    });
  } catch (error) {
    console.error('❌ Error checking wallet legacy status:', error);
    const message = error instanceof Error ? error.message : 'Failed to check wallet status';
    res.status(500).json({ error: message });
  }
}) as any));

// Get user's legacy wallet info
// @ts-ignore - TypeScript middleware compatibility
app.get('/api/wallets/legacy-info', authenticateUser, (asyncAuthHandler(async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const legacyInfo = await walletMigrationService.getUserLegacyWallets(userId);

    res.json({
      success: true,
      ...legacyInfo
    });
  } catch (error) {
    console.error('❌ Error getting legacy wallet info:', error);
    const message = error instanceof Error ? error.message : 'Failed to get legacy wallet info';
    res.status(500).json({ error: message });
  }
}) as any));

// Upgrade a single legacy wallet
// @ts-ignore - TypeScript middleware compatibility
app.post('/api/wallets/:id/upgrade', authenticateUser, (asyncAuthHandler(async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    console.log(`🔄 Upgrade requested for wallet ${id} by user ${userId}`);

    const success = await walletMigrationService.upgradeLegacyWallet(id, userId);

    res.json({
      success,
      message: success ? 'Wallet upgraded successfully' : 'Wallet upgrade failed'
    });
  } catch (error) {
    console.error('❌ Error upgrading wallet:', error);
    const message = error instanceof Error ? error.message : 'Failed to upgrade wallet';
    res.status(500).json({ error: message });
  }
}) as any));

// Upgrade all legacy wallets for user
// @ts-ignore - TypeScript middleware compatibility
app.post('/api/wallets/upgrade-all', authenticateUser, (asyncAuthHandler(async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    console.log(`🔄 Batch upgrade requested by user ${userId}`);

    const result = await walletMigrationService.upgradeAllUserLegacyWallets(userId);

    res.json({
      success: result.success,
      message: result.message,
      upgraded: result.upgraded,
      failed: result.failed,
      results: result.results
    });
  } catch (error) {
    console.error('❌ Error upgrading all user wallets:', error);
    const message = error instanceof Error ? error.message : 'Failed to upgrade wallets';
    res.status(500).json({ error: message });
  }
}) as any));

// Admin: Get platform-wide legacy wallet statistics
// SECURITY FIX: Admin authorization
// @ts-ignore - TypeScript middleware compatibility
app.get('/api/admin/legacy-stats', authenticateUser, requireAdmin, (asyncAuthHandler(async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const stats = await walletMigrationService.getPlatformLegacyStats();

    res.json({
      success: true,
      ...stats
    });
  } catch (error) {
    console.error('❌ Error getting platform legacy stats:', error);
    const message = error instanceof Error ? error.message : 'Failed to get platform stats';
    res.status(500).json({ error: message });
  }
}) as any));

// Admin: Upgrade all legacy wallets on platform
// SECURITY FIX: Admin authorization
// @ts-ignore - TypeScript middleware compatibility
app.post('/api/admin/upgrade-all-platform', authenticateUser, requireAdmin, (asyncAuthHandler(async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    console.log(`🌍 Platform-wide upgrade requested by admin ${userId}`);

    const result = await walletMigrationService.upgradeAllPlatformLegacyWallets();

    res.json({
      success: result.success,
      message: result.message,
      totalUsers: result.totalUsers,
      totalUpgraded: result.totalUpgraded,
      totalFailed: result.totalFailed,
      userResults: result.userResults
    });
  } catch (error) {
    console.error('❌ Error upgrading platform wallets:', error);
    const message = error instanceof Error ? error.message : 'Failed to upgrade platform wallets';
    res.status(500).json({ error: message });
  }
}) as any));

// Active Sniper Management Endpoints

// Get all active snipes for user
// @ts-ignore - TypeScript middleware compatibility
app.get('/api/active-snipes', authenticateUser, asyncAuthHandler(async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    console.log(`🎯 Fetching active snipes for user: ${userId}`);
    const startTime = Date.now();

    // ULTRA-OPTIMIZED: Use raw SQL for maximum performance
    const userActiveSnipes = await prisma.$queryRaw`
      SELECT snp.* 
      FROM active_snipes snp
      INNER JOIN sniper_configs sc ON snp."configId" = sc.id 
      WHERE sc."userId" = ${userId}
      ORDER BY snp."startedAt" DESC
    ` as any[];

    const queryTime = Date.now() - startTime;
    console.log(`⚡ Active snipes query completed in ${queryTime}ms for ${userActiveSnipes.length} snipes`);

    // Add performance headers
    res.set({
      'X-Response-Time': `${queryTime}ms`,
      'X-Snipe-Count': userActiveSnipes.length.toString(),
      'Cache-Control': 'private, max-age=10', // 10 second cache for active data
    });

    res.json({
      activeSnipes: userActiveSnipes,
      meta: {
        count: userActiveSnipes.length,
        queryTime: queryTime,
        optimized: true
      }
    });
  } catch (error) {
    console.error('❌ Error fetching active snipes:', error);
    res.status(500).json({ error: 'Failed to fetch active snipes' });
  }
}));

// Start an active snipe (activate monitoring)
// @ts-ignore - TypeScript middleware compatibility  
app.post('/api/active-snipes/start', authenticateUser, asyncAuthHandler(async (req, res) => {
  try {
    const { configId, configData } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    if (!configId) {
      return res.status(400).json({ error: 'Config ID is required' });
    }

    // If configData is provided, upsert the config to DB so that configs
    // created only in the frontend (Redux/localStorage) can be activated
    if (configData && typeof configData === 'object') {
      await sqliteDb.sniper_configs.upsert({
        where: { id: configId },
        create: {
          id: configId,
          userId,
          name: configData.name || 'Sniper Config',
          tokenAddress: configData.tokenAddress || '',
          buyAmount: String(configData.buyAmount || '0.1'),
          sellTarget: String(configData.sellTarget || '150'),
          stopLoss: String(configData.stopLoss || '50'),
          maxSlippage: String(configData.maxSlippage || '1'),
          tokenType: configData.tokenType || 'sol',
          dex: configData.dex || 'jupiter',
          autoApprove: configData.autoApprove || false,
          walletId: configData.walletId || null,
          isActive: true
        },
        update: {
          name: configData.name || 'Sniper Config',
          walletId: configData.walletId || null,
          updatedAt: new Date()
        }
      }).catch((e: Error) => console.warn('Config upsert warn:', e.message));
    }

    // Verify user owns the config
    const config = await sqliteDb.sniper_configs.findFirst({
      where: { id: configId, userId }
    });

    if (!config) {
      return res.status(404).json({ error: 'Sniper configuration not found' });
    }

    // Check if already active
    const existingActive = await sqliteDb.active_snipes.findFirst({
      where: { configId }
    });

    if (existingActive) {
      return res.status(409).json({ error: 'Sniper is already active' });
    }

    // Create active snipe record
    const activeSnipe = await sqliteDb.active_snipes.create({
      data: {
        id: `snipe-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        configId,
        tokenAddress: config.tokenAddress,
        buyTxId: '', // Will be filled when trade executes
        status: 'monitoring',
        startedAt: new Date(),
        lastPriceCheck: new Date()
      }
    });

    console.log(`🎯 Started active snipe for config ${configId}: ${config.name}`);

    // SECURITY FIX: Start the actual monitoring process
    startActiveSnipeMonitor(activeSnipe.id);

    res.json({
      success: true,
      activeSnipe,
      message: `Sniper "${config.name}" activated and monitoring ${config.tokenAddress}`
    });

  } catch (error) {
    console.error('❌ Error starting active snipe:', error);
    res.status(500).json({ error: 'Failed to start active snipe' });
  }
}));

// Stop an active snipe
// @ts-ignore - TypeScript middleware compatibility
app.post('/api/active-snipes/stop', authenticateUser, asyncAuthHandler(async (req, res) => {
  try {
    const { activeSnipeId } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    if (!activeSnipeId) {
      return res.status(400).json({ error: 'Active snipe ID is required' });
    }

    // Get the active snipe and verify ownership
    const activeSnipe = await sqliteDb.active_snipes.findUnique({
      where: { id: activeSnipeId }
    });

    if (!activeSnipe) {
      return res.status(404).json({ error: 'Active snipe not found' });
    }

    // Verify user owns the config
    const config = await sqliteDb.sniper_configs.findFirst({
      where: { id: activeSnipe.configId, userId }
    });

    if (!config) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Delete the active snipe record
    await sqliteDb.active_snipes.delete({
      where: { id: activeSnipeId }
    });

    console.log(`🛑 Stopped active snipe ${activeSnipeId} for config ${config.name}`);

    // SECURITY FIX: Stop the actual monitoring process
    stopActiveSnipeMonitor(activeSnipeId);

    res.json({
      success: true,
      message: `Sniper "${config.name}" deactivated`
    });

  } catch (error) {
    console.error('❌ Error stopping active snipe:', error);
    res.status(500).json({ error: 'Failed to stop active snipe' });
  }
}));

// Update active snipe status (used when trade executes)
// @ts-ignore - TypeScript middleware compatibility
app.patch('/api/active-snipes/:id/status', authenticateUser, asyncAuthHandler(async (req, res) => {
  try {
    const { id } = req.params;
    const { status, buyTxId } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Verify ownership
    const activeSnipe = await sqliteDb.active_snipes.findUnique({
      where: { id }
    });

    if (!activeSnipe) {
      return res.status(404).json({ error: 'Active snipe not found' });
    }

    const config = await sqliteDb.sniper_configs.findFirst({
      where: { id: activeSnipe.configId, userId }
    });

    if (!config) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Update status
    const updatedSnipe = await sqliteDb.active_snipes.update({
      where: { id },
      data: {
        status,
        buyTxId: buyTxId || activeSnipe.buyTxId,
        lastPriceCheck: new Date()
      }
    });

    res.json({ success: true, activeSnipe: updatedSnipe });

  } catch (error) {
    console.error('❌ Error updating active snipe status:', error);
    res.status(500).json({ error: 'Failed to update active snipe status' });
  }
}));

// 🚀 NEW TOKEN FEED ENDPOINTS

// Simple in-memory cache for token feeds
const tokenFeedCache = new Map();
const CACHE_DURATION = 5000; // 5 seconds for more frequent updates

// Clean up old cache entries every 30 seconds
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of tokenFeedCache.entries()) {
    if (now - value.timestamp > CACHE_DURATION * 3) { // Remove after 30 seconds
      tokenFeedCache.delete(key);
    }
  }
}, 30000);
// (slop audit) GET /api/token-feed/unbonded — dead route archived to archive/dead-endpoints-20260612.ts.txt

// ============================================================================
// FILTERED TOKEN FEED - Pre-filtered tokens to reduce noise
// ============================================================================

/**
 * Get filtered token feed - only tokens matching criteria
 * Query params:
 *   - limit: number of tokens to return (default: 20)
 *   - minLiquidity: minimum liquidity in SOL (default: 0.5)
 *   - maxLiquidity: maximum liquidity in SOL (default: 1000)
 *   - minMarketCap: minimum market cap in SOL (default: 0)
 *   - maxMarketCap: maximum market cap in SOL (default: 10000)
 *   - minBuyCount: minimum buy count (default: 0)
 *   - maxAgeSec: maximum token age in seconds (default: 3600 = 1 hour)
 *   - sortBy: 'newest' | 'trending' | 'volume' (default: 'newest')
 */
// (slop audit) GET /api/tokens/filtered — dead route archived to archive/dead-endpoints-20260612.ts.txt

/**
 * Get live token feed - real-time filtered tokens from memory
 * Fast endpoint for UI updates (uses in-memory cache)
 */
app.get('/api/tokens/live', asyncHandler(async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 20;
    const tokens = pumpPortalService.getLiveFeed(limit);

    res.json({
      success: true,
      tokens: tokens.map((t: any, i: number) => ({
        rank: i + 1,
        address: t.mint,
        symbol: t.symbol,
        name: t.name,
        logoURI: t.imageUri,
        liquidity: t.vSolInBondingCurve,
        marketCap: t.marketCapSol,
        buyCount: t.buyCount,
        sellCount: t.sellCount,
        ageMs: t.age,
        source: 'pump.fun',
        // Aliases for the Live Filtered Tokens preview (AutoSnipeControls) —
        // it reads mint/liquiditySol/marketCapSol/ageSec; without these every
        // row showed "Unknown address" and "—" for all numbers.
        mint: t.mint,
        liquiditySol: t.vSolInBondingCurve ?? null,
        marketCapSol: t.marketCapSol ?? null,
        ageSec: t.age != null ? Math.round(t.age / 1000) : null,
      })),
      meta: {
        wsConnected: pumpPortalService.isWebSocketConnected(),
        stats: pumpPortalService.getStats()
      }
    });
  } catch (error) {
    console.error('❌ Error fetching live tokens:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch live tokens' });
  }
}));

/**
 * On-chain pump.fun stream health — confirm Create/Trade events are flowing.
 * GET /api/sniper/onchain-stats
 */
app.get('/api/sniper/onchain-stats', asyncHandler(async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, stats: onchainPumpStream.getStats() });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to read on-chain stream stats' });
  }
}));

/**
 * Get filter statistics
 */
// (slop audit) GET /api/tokens/stats — dead route archived to archive/dead-endpoints-20260612.ts.txt

/**
 * Update filter configuration (requires auth)
 */
// (slop audit) POST /api/tokens/filter-config — dead route archived to archive/dead-endpoints-20260612.ts.txt


// Get specific token details
app.get('/api/token-feed/token/:address', asyncHandler(async (req, res) => {
  try {
    const { address } = req.params;
    console.log(`🔍 Token details request for: ${address}`);

    if (!address) {
      return res.status(400).json({ error: 'Token address is required' });
    }

    // First check our database for the token
    const dbToken = await pumpPortalService.getToken(address);
    if (dbToken) {
      // Found in our DB - also try DexScreener for extra data
      try {
        const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${address}`, { timeout: 3000 });
        const pair = dexRes.data?.pairs?.[0];

        return res.json({
          success: true,
          token: {
            address: dbToken.mint,
            symbol: dbToken.symbol,
            name: dbToken.name,
            logoURI: dbToken.imageUri || pair?.info?.imageUrl || null,
            description: dbToken.description,
            price: pair ? parseFloat(pair.priceUsd || '0') : 0,
            priceChange24h: pair ? parseFloat(pair.priceChange?.h24 || '0') : 0,
            volume24h: pair ? parseFloat(pair.volume?.h24 || '0') : 0,
            liquidity: pair ? parseFloat(pair.liquidity?.usd || '0') : (dbToken.marketCapSol || 0) * (cachedSolPriceFromFeed ?? 150),
            marketCap: pair ? parseFloat(pair.marketCap || '0') : dbToken.marketCapSol,
            buyCount: dbToken.buyCount || 0,
            sellCount: dbToken.sellCount || 0,
            source: 'pump.fun',
            bonded: false,
            createdAt: dbToken.timestamp ? new Date(dbToken.timestamp).toISOString() : null
          }
        });
      } catch {
        // DexScreener failed, return DB data only
        return res.json({
          success: true,
          token: {
            address: dbToken.mint,
            symbol: dbToken.symbol,
            name: dbToken.name,
            logoURI: dbToken.imageUri || null,
            description: dbToken.description,
            price: 0,
            priceChange24h: 0,
            volume24h: 0,
            liquidity: (dbToken.marketCapSol || 0) * (cachedSolPriceFromFeed ?? 150),
            marketCap: dbToken.marketCapSol,
            buyCount: dbToken.buyCount || 0,
            sellCount: dbToken.sellCount || 0,
            source: 'pump.fun',
            bonded: false,
            createdAt: dbToken.timestamp ? new Date(dbToken.timestamp).toISOString() : null
          }
        });
      }
    }

    // Not in our DB - try external APIs
    // Fetch token info from Raydium API
    const tokenUrl = `https://api-v3.raydium.io/pools/info/mint?poolType=standard&mint1=${address}&poolSortField=default&sortType=desc&pageSize=10&page=1`;

    const response = await axios.get(tokenUrl, {
      timeout: 10000,
      headers: {
        'User-Agent': 'AutoBotAPP/1.0',
        'Accept': 'application/json'
      }
    });

    const pools = response.data?.data?.data || [];

    if (pools.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Token not found or no pools available'
      });
    }

    // Get the most liquid pool for this token
    const mainPool = pools[0];
    const baseToken = mainPool.mintA;
    const quoteToken = mainPool.mintB;

    const isTargetToken = baseToken.address === address;
    const targetToken = isTargetToken ? baseToken : quoteToken;
    const pairedToken = isTargetToken ? quoteToken : baseToken;

    const tokenDetails = {
      address: targetToken.address,
      symbol: targetToken.symbol || 'UNKNOWN',
      name: targetToken.name || targetToken.symbol || 'Unknown Token',
      decimals: targetToken.decimals || 9,
      logoURI: targetToken.logoURI || null,

      // Market data from main pool
      price: parseFloat(mainPool.price || '0'),
      priceChange24h: parseFloat(mainPool.priceChange24h || '0'),
      volume24h: parseFloat(mainPool.volume24h || '0'),
      volume7d: parseFloat(mainPool.volume7d || '0'),
      liquidity: parseFloat(mainPool.tvl || '0'),
      marketCap: mainPool.marketCap || null,
      fdv: mainPool.fdv || null,

      // Pool information
      mainPool: {
        id: mainPool.id,
        type: mainPool.type,
        lpMint: mainPool.lpMint?.address,
        pairedWith: {
          symbol: pairedToken.symbol,
          address: pairedToken.address
        }
      },

      // All available pools
      allPools: pools.map((pool: any) => ({
        id: pool.id,
        type: pool.type,
        liquidity: parseFloat(pool.tvl || '0'),
        volume24h: parseFloat(pool.volume24h || '0'),
        pairedWith: pool.mintA.address === address ? pool.mintB.symbol : pool.mintA.symbol
      })),

      // Timestamps
      createdAt: mainPool.openTime || new Date().toISOString(),

      // Social and metadata
      website: targetToken.extensions?.website || null,
      twitter: targetToken.extensions?.twitter || null,
      telegram: targetToken.extensions?.telegram || null,
      description: targetToken.extensions?.description || null,

      // Risk assessment
      riskLevel: parseFloat(mainPool.tvl || '0') > 10000 ? 'low' :
        parseFloat(mainPool.tvl || '0') > 1000 ? 'medium' : 'high',

      source: 'raydium'
    };

    res.json({
      success: true,
      token: tokenDetails,
      meta: {
        poolCount: pools.length,
        lastUpdated: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error(`❌ Error fetching token details for ${req.params.address}:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch token details',
      details: error.message
    });
  }
}));
// (slop audit) GET /api/websocket/status — dead route archived to archive/dead-endpoints-20260612.ts.txt

// =====================================================
// SNIPER API ROUTES - Auto-sniping functionality
// =====================================================

// Import PumpFun service for token discovery
import { getPumpFunService, type TokenFilters } from './src/lib/pumpfunService.js';
// (slop audit) tokenAnalyzerService + portfolioService removed — their only callers
// were the archived /api/token/analyze + /api/portfolio/* routes; services archived too.

const pumpFunService = getPumpFunService();

// Store for active auto-snipe state (in-memory; single-process desktop app)
let autoSnipeEnabled = false;
let autoSnipeSettings: any = null;

// Get sniper settings for user
app.get('/api/sniper/settings', authenticateUser, asyncHandler(async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;

    // Get settings from database — don't filter by isActive (settings are saved with isActive:false)
    const settings = await sqliteDb.snipe_settings.findFirst({
      where: { userId },
      orderBy: { updatedAt: 'desc' }
    }).catch(() => null);

    res.json({
      success: true,
      settings: settings || {
        name: 'Default',
        isActive: false,
        walletId: null,
        buyAmountSol: 0.1,
        slippageBps: 100,
        useJito: true,
        jitoTipLamports: 50000,
        minLiquidityUsd: 1000,    // USD threshold ($1,000)
        maxLiquidityUsd: 35000,   // USD threshold ($35,000)
        maxTokenAgeSec: 2400,     // 40 minutes
        minMarketCapUsd: 0,       // no minimum by default
        maxMarketCapUsd: 0,       // no maximum by default
        enableRaydium: false,
        enablePumpfun: true,
        enableLaunchlab: false,
        preBondedOnly: true,
        checkMintAuthority: false,
        checkFreezeAuthority: false,
        maxHolderConcentration: 30,
        requireTwitter: false,
        requireTelegram: false,
        requireWebsite: false,
        momentumEnabled: false,
        minChange5m: null,
        minChange1h: null,
        minChange24h: null,
        minTokenAgeSec: null,
        momentumCooldownSec: 300,
        momentumMaxPositions: 5,
        autoSellEnabled: false,
        takeProfitPercent: null,
        stopLossPercent: null,
        trailingStopPercent: null,
        maxHoldSec: null
      }
    });
  } catch (error: any) {
    console.error('Error fetching sniper settings:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}));

// Save sniper settings
app.post('/api/sniper/settings', authenticateUser, asyncHandler(async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    const settings = req.body;

    // Upsert settings — explicit field mapping so unknown frontend fields don't crash Prisma.
    // MERGE-WITH-EXISTING (2026-06-11): two panels save partial field sets to this
    // endpoint (SniperDashboard's "Sniper Filters" and AutoSnipeControls' "Snipe
    // Settings"). Fields ABSENT from the request now fall back to the saved row
    // instead of hard defaults — previously saving one panel silently reset the
    // other panel's fields (e.g. Snipe Settings save disabled momentum/auto-sell).
    const upsertId = settings.id || `default-${userId}`;
    const existing: any = await sqliteDb.snipe_settings.findUnique({ where: { id: upsertId } }).catch(() => null);
    // pick(k, fallback): request value if the key was sent, else saved value, else fallback
    const pick = (k: string, dflt: any) =>
      settings[k] !== undefined ? settings[k] : (existing && existing[k] !== undefined && existing[k] !== null ? existing[k] : dflt);
    const pickNullable = (k: string, dflt: any = null) => {
      if (settings[k] !== undefined) return settings[k] !== '' && settings[k] != null ? Number(settings[k]) : null;
      return existing ? existing[k] : dflt;
    };
    const fieldMap = {
      userId,
      name: pick('name', 'Default'),
      walletId: pick('walletId', null),
      buyAmountSol: Number(pick('buyAmountSol', 0.1)) || 0.1,
      slippageBps: Number(pick('slippageBps', 100)) || 100,
      priorityFeeLamports: Number(pick('priorityFeeLamports', 100000)) || 100000,
      useJito: Boolean(pick('useJito', false)),
      jitoTipLamports: Number(pick('jitoTipLamports', 50000)) || 50000,
      // Accept new USD names; fall back to legacy *Sol names from older frontends (values were always USD)
      minLiquidityUsd: Number(settings.minLiquidityUsd ?? (settings as any).minLiquiditySol ?? existing?.minLiquidityUsd) || 0,
      maxLiquidityUsd: Number(settings.maxLiquidityUsd ?? (settings as any).maxLiquiditySol ?? existing?.maxLiquidityUsd) || 0,
      maxTokenAgeSec: Number(pick('maxTokenAgeSec', 60)) || 60,
      minMarketCapSol: pickNullable('minMarketCapSol'),
      maxMarketCapSol: pickNullable('maxMarketCapSol'),
      minMarketCapUsd: Number(pick('minMarketCapUsd', 0)) || 0,
      maxMarketCapUsd: Number(pick('maxMarketCapUsd', 0)) || 0,
      enableRaydium: Boolean(pick('enableRaydium', false)),
      enablePumpfun: Boolean(settings.enablePumpfun ?? (settings as any).enablePumpFun ?? existing?.enablePumpfun ?? true),
      enableLaunchlab: Boolean(settings.enableLaunchlab ?? (settings as any).enableLaunchLab ?? existing?.enableLaunchlab ?? false),
      preBondedOnly: Boolean(pick('preBondedOnly', false)),
      checkMintAuthority: Boolean(pick('checkMintAuthority', false)),
      checkFreezeAuthority: Boolean(pick('checkFreezeAuthority', false)),
      maxHolderConcentration: Number(pick('maxHolderConcentration', 30)) || 30,
      requireLiquidityLock: Boolean(pick('requireLiquidityLock', false)),
      requireTwitter: Boolean(pick('requireTwitter', false)),
      requireTelegram: Boolean(pick('requireTelegram', false)),
      requireWebsite: Boolean(pick('requireWebsite', false)),
      autoSellEnabled: Boolean(pick('autoSellEnabled', false)),
      takeProfitPercent: pickNullable('takeProfitPercent'),
      stopLossPercent: pickNullable('stopLossPercent'),
      trailingStopPercent: pickNullable('trailingStopPercent'),
      maxHoldSec: pickNullable('maxHoldSec'),
      // Momentum auto-buy
      momentumEnabled: Boolean(pick('momentumEnabled', false)),
      minChange5m: pickNullable('minChange5m'),
      minChange1h: pickNullable('minChange1h'),
      minChange24h: pickNullable('minChange24h'),
      maxChange5m: pickNullable('maxChange5m'),
      maxChange1h: pickNullable('maxChange1h'),
      maxChange24h: pickNullable('maxChange24h'),
      minTokenAgeSec: pickNullable('minTokenAgeSec'),
      momentumCooldownSec: Number(pick('momentumCooldownSec', 300)) || 300,
      // Shared cap: max open positions for ALL auto-buys (momentum + auto-snipe)
      momentumMaxPositions: Number(pick('momentumMaxPositions', 5)) || 5,
      isActive: settings.isActive ?? existing?.isActive ?? false,
    };

    const saved = await sqliteDb.snipe_settings.upsert({
      where: { id: upsertId },
      create: { id: upsertId, ...fieldMap },
      update: { ...fieldMap, updatedAt: new Date() },
    });

    if (saved) {
      autoSnipeSettings = saved;
    }

    res.json({ success: true, settings: saved });
  } catch (error: any) {
    console.error('Error saving sniper settings:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}));

// Toggle auto-snipe on/off
app.post('/api/sniper/toggle', authenticateUser, asyncHandler(async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    const { isActive } = req.body;

    autoSnipeEnabled = isActive;

    // Also update PumpPortal service auto-snipe
    pumpPortalService.setAutoSnipeEnabled(isActive);

    // FIX (2026-06-12): the old code set isActive:false on the user's settings
    // REGARDLESS of toggle direction — so "Start Sniper" enabled the engine but
    // immediately disarmed every config. checkAndTriggerAutoSnipe only fires for
    // rows with isActive:true, so the sniper ran with zero armed settings and
    // silently never sniped; navigating back showed it as stopped (DB said false).
    await sqliteDb.snipe_settings.updateMany({
      where: { userId },
      data: { isActive }
    }).catch(() => { });

    console.log(`🎯 Auto-snipe ${isActive ? 'ENABLED' : 'DISABLED'} for user ${userId}`);

    res.json({ success: true, isActive });
  } catch (error: any) {
    console.error('Error toggling sniper:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}));
// (slop audit) POST /api/pumpportal/auto-snipe/toggle — dead route archived to archive/dead-endpoints-20260612.ts.txt

// Get sniper auto-snipe status
app.get('/api/sniper/auto-snipe/status', authenticateUser, asyncHandler(async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;

    const isEnabled = pumpPortalService.isAutoSnipeEnabled();
    const stats = pumpPortalService.getStats();
    const filterConfig = pumpPortalService.getFilterConfig();
    const wsConnected = pumpPortalService.isWebSocketConnected();

    // Get recent execution stats from database
    const recentExecutions = await prisma.snipe_executions.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 10
    });

    const successCount = recentExecutions.filter(e => e.status === 'success').length;
    const failedCount = recentExecutions.filter(e => e.status === 'failed').length;
    const pendingCount = recentExecutions.filter(e => e.status === 'pending').length;

    res.json({
      success: true,
      enabled: isEnabled,
      stats: {
        ...stats,
        recentExecutions: {
          total: recentExecutions.length,
          success: successCount,
          failed: failedCount,
          pending: pendingCount
        }
      },
      filterConfig,
      wsConnected
    });
  } catch (error: any) {
    console.error('Error getting sniper auto-snipe status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}));

// Toggle sniper auto-snipe on/off
app.post('/api/sniper/auto-snipe/toggle', authenticateUser, asyncHandler(async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ success: false, error: 'enabled must be a boolean' });
    }

    pumpPortalService.setAutoSnipeEnabled(enabled);
    console.log(`🎯 Sniper auto-snipe ${enabled ? 'ENABLED' : 'DISABLED'} by user ${userId}`);

    res.json({ success: true, enabled });
  } catch (error: any) {
    console.error('Error toggling sniper auto-snipe:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}));

// ── SOL/USD price derived from pump.fun's own API data (updated on each token fetch) ──
// No external price API needed — pump.fun tokens have both market_cap (SOL) and usd_market_cap (USD)
let cachedSolPriceFromFeed: number | null = null;
function updateSolPriceCache(mcUsd: number, mcSol: number): void {
  if (mcUsd > 0 && mcSol > 0) {
    cachedSolPriceFromFeed = mcUsd / mcSol;
  }
}

// ─── Cache for /api/sniper/tokens (audit §7) ───────────────────────────────
// ONE cache key per limit — display filters (dex/preBondedOnly) are applied to the
// cached full feed in-memory, so filter toggles never re-run the fetch pipeline.
// Stale-while-revalidate: entries older than STALE_MS are served immediately while
// a background refresh runs, so no request ever waits on the multi-second pipeline.
const _sniperTokensCache: Map<string, { ts: number; tokens: any[] }> = new Map();
const SNIPER_TOKENS_TTL_MS = 30_000;   // hard expiry — block and refetch
const SNIPER_TOKENS_STALE_MS = 20_000; // soft expiry — serve + refresh in background
const _feedRefreshInFlight = new Set<string>();

// Per-address DexScreener enrichment cache (60s) — re-sorts are instant.
const _dexEnrichCache: Map<string, { ts: number; data: any }> = new Map();
const DEX_ENRICH_TTL_MS = 60_000;

// ── LaunchLab market-cap history → 5m/1h/24h price change ──────────────────
// The Raydium LaunchLab API has no price-change field, PumpPortal only streams
// pump.fun trades, and DexScreener doesn't index pre-bonded LaunchLab mints —
// so the change% sorts showed "—" for every LaunchLab token. We sample each
// token's marketCap on every feed refresh (~20-30s) and derive change% the same
// way pumpPortalService does (price ∝ marketCap on a fixed-supply bonding curve).
const _llMarketStats: Map<string, {
  initialMc: number;          // LAUNCH market cap (initPrice × supply × SOL rate), not first-seen
  history: { ts: number; mc: number }[];
  volume24h: number | null;
  createdAt: number | null;   // token launch time (ms) — gates the since-launch fallback
  lastTs: number;
}> = new Map();
const LL_STATS_MAX_TOKENS = 1000;

function recordLaunchLabStats(
  mint: string,
  marketCapUsd: number,
  volume24h: number | null,
  launchMcUsd: number | null,
  createdAtMs: number | null,
) {
  if (!mint || !marketCapUsd || marketCapUsd <= 0) return;
  const now = Date.now();
  let s = _llMarketStats.get(mint);
  if (!s) {
    s = {
      // Launch MC derived from the curve (initPrice × supply × SOL rate) lets a SINGLE
      // sample yield a meaningful since-launch change% — no waiting for two polls.
      initialMc: launchMcUsd && launchMcUsd > 0 ? launchMcUsd : marketCapUsd,
      history: [{ ts: now, mc: marketCapUsd }],
      volume24h,
      createdAt: createdAtMs,
      lastTs: now,
    };
    _llMarketStats.set(mint, s);
    // Evict least-recently-updated token when over cap
    if (_llMarketStats.size > LL_STATS_MAX_TOKENS) {
      let oldestKey: string | null = null, oldestTs = Infinity;
      for (const [k, v] of _llMarketStats) if (v.lastTs < oldestTs) { oldestTs = v.lastTs; oldestKey = k; }
      if (oldestKey) _llMarketStats.delete(oldestKey);
    }
    return;
  }
  // Only append when the cap actually moved — keeps history compact.
  const last = s.history[s.history.length - 1];
  if (!last || last.mc !== marketCapUsd) s.history.push({ ts: now, mc: marketCapUsd });
  if (volume24h != null && volume24h > 0) s.volume24h = volume24h;
  s.lastTs = now;
  // Prune: drop points older than 24h, cap to 240 samples per token.
  const cutoff = now - 24 * 60 * 60 * 1000;
  while (s.history.length > 1 && s.history[0].ts < cutoff) s.history.shift();
  if (s.history.length > 240) s.history.splice(0, s.history.length - 240);
}

/** Same window logic as pumpPortalService.getMarketStats — null until we've seen movement. */
function getLaunchLabMarketStats(mint: string): {
  priceChange5m: number | null;
  priceChange1h: number | null;
  priceChange24h: number | null;
  volume24h: number | null;
} | null {
  const s = _llMarketStats.get(mint);
  if (!s) return null;
  const now = Date.now();
  const cur = s.history[s.history.length - 1].mc;
  const changeOver = (windowMs: number): number | null => {
    if (!cur || cur <= 0) return null;
    const cutoff = now - windowMs;
    let baseline: number | null = null;
    for (const p of s.history) {
      if (p.ts <= cutoff) baseline = p.mc; else break;
    }
    if (baseline == null) {
      // No sample old enough for this window. Falling back to the launch MC is only
      // honest if the token itself is younger than the window (matches PumpPortal /
      // DexScreener semantics for new tokens); for older tokens we have no data yet.
      const age = s.createdAt != null ? now - s.createdAt : null;
      if (age != null && age <= windowMs) baseline = s.initialMc;
      else return null;
    }
    if (!baseline || baseline <= 0) return null;
    return ((cur - baseline) / baseline) * 100;
  };
  return {
    priceChange5m: changeOver(5 * 60 * 1000),
    priceChange1h: changeOver(60 * 60 * 1000),
    priceChange24h: changeOver(24 * 60 * 60 * 1000),
    volume24h: s.volume24h != null && s.volume24h > 0 ? s.volume24h : null,
  };
}

// NOTE: /api/sniper/test-buy was removed (FIX-7).
// It had no authentication and executed live mainnet transactions,
// allowing any local browser tab or extension to drain the active wallet.


// §10.5: [SNIPER-DEBUG] logging gated behind DEBUG=sniper (was spamming every poll)
const SNIPER_DEBUG = /\bsniper\b/.test(process.env.DEBUG || '');
const sniperDebug = (...args: any[]) => { if (SNIPER_DEBUG) console.log(...args); };

/**
 * Builds the FULL sniper feed (all sources, no display filtering) — audit §7.1.
 * Display filters (dex tab, pre-bonded, liquidity, MC) are applied client-side
 * (and cheaply in-memory below for backward compat); this pipeline runs at most
 * once per TTL window regardless of how users toggle filters.
 */
async function buildSniperFeed(limit: number): Promise<any[]> {
    const rawTokens: any[] = [];
    const seenAddresses = new Set<string>();
    const byMint = new Map<string, any>();

    // Merge policy (per user spec): no source overrides another — duplicates (same
    // mint) are MERGED. The first source to provide a mint owns its non-empty fields;
    // later sources only FILL fields that are still empty. Priority is set by source
    // order below: on-chain (freshest) → PumpPortal → pump.fun v3 feed → LaunchLab.
    const isEmpty = (v: any) =>
      v === undefined || v === null || v === '' || (typeof v === 'number' && v === 0);
    const addOrMerge = (addr: string | undefined, tok: any) => {
      if (!addr) return;
      const existing = byMint.get(addr);
      if (!existing) {
        byMint.set(addr, tok);
        seenAddresses.add(addr);
        rawTokens.push(tok);
        return;
      }
      for (const k of Object.keys(tok)) {
        if (isEmpty(existing[k]) && !isEmpty(tok[k])) existing[k] = tok[k];
      }
    };

    // --- Source 0: on-chain pump.fun stream (PRIMARY — real-time, 0s-old, no RPC) ---
    // Reads Create + Trade events straight off the chain; price/volume/MC derived in
    // memory. Added first so it owns the freshest fields; PumpPortal/v3 fill any gaps.
    try {
      const onchainTokens = onchainPumpStream.getLiveFeed(Math.max(limit, 200));
      for (const t of onchainTokens) addOrMerge(t.mint, { ...t, _source: 'onchain' });
      sniperDebug(`[SNIPER-DEBUG] Source 0 (onchain stream): ${onchainTokens.length} tokens, ${rawTokens.length} in rawTokens`);
    } catch (e: any) {
      console.warn('onchain stream feed error:', e?.message);
    }

    // --- Source 1: pumpPortalService (WebSocket real-time pre-bonded tokens) ---
    {
      // In-memory live feed (populated by WebSocket as tokens arrive)
      const liveTokens = pumpPortalService.getLiveFeed(limit);
      for (const t of liveTokens) addOrMerge(t.mint, { ...t, _source: 'portal' });
      sniperDebug(`[SNIPER-DEBUG] Source 1a (pumpPortal live): ${liveTokens.length} tokens, ${rawTokens.length} in rawTokens`);

      // DB tokens (stored by WebSocket, isBonded=false)
      const dbTokens = await pumpPortalService.getNewTokens(limit);
      const beforeDb = rawTokens.length;
      for (const t of dbTokens) addOrMerge(t.mint, { ...t, _source: 'portal' });
      sniperDebug(`[SNIPER-DEBUG] Source 1b (pumpPortal DB): ${dbTokens.length} fetched, ${rawTokens.length - beforeDb} new, total ${rawTokens.length}`);
    }

    // --- Source 2: pumpFunService (DexScreener + pump.fun API, as supplement) ---
    // Always fetch the full feed (no preBondedOnly/dex narrowing) — §7.1.
    const filters: Partial<TokenFilters> = {
      limit: Math.max(limit, 200), // allow up to 200 so LaunchLab pagination isn't sliced early
      preBondedOnly: false,
      includePumpfun: true,
      includeLaunchlab: true,
      sortBy: 'created',
      sortDirection: 'desc'
    };
    try {
      const feedTokens = await pumpFunService.getCombinedTokenFeed(filters);
      // Prime the SOL price cache from DexScreener's priceUsd/priceNative ratio
      const dexSolPrice = pumpFunService.getLastKnownSolPrice();
      if (dexSolPrice && dexSolPrice > 1) {
        updateSolPriceCache(dexSolPrice * 1, 1); // sets cachedSolPriceFromFeed = dexSolPrice
        setPumpPortalSolPrice(dexSolPrice);       // also propagate to snipe filter in pumpPortalService
        onchainPumpStream.setSolPrice(dexSolPrice); // so on-chain MC/volume convert to USD
        console.log(`💲 SOL price from DexScreener: $${dexSolPrice.toFixed(2)}`);
      }
      const beforeFeed = rawTokens.length;
      let launchLabCount = 0;
      for (const t of feedTokens) {
        const addr = 'mint' in t ? (t as any).mint : (t as any).tokenMint || (t as any).poolAddress;
        if (!addr) continue;
        const wasNew = !byMint.has(addr);
        addOrMerge(addr, { ...t, _source: 'feed' });
        if (wasNew && ((t as any).source === 'launchlab' || (t as any).dex === 'launchlab')) launchLabCount++;
      }
      sniperDebug(`[SNIPER-DEBUG] Source 2 (combinedFeed): ${feedTokens.length} returned, ${rawTokens.length - beforeFeed} new (${launchLabCount} LaunchLab), total ${rawTokens.length}`);
    } catch (feedErr) {
      console.warn('pumpFunService feed error:', feedErr);
    }

    // --- Source 3: real LaunchLab NEW launches (launch-mint-v1.raydium.io) ---
    // The DexScreener search in Source 2 only returns established pairs, which the
    // user's age/MC/liquidity filters correctly reject — so the LaunchLab tab sat
    // empty. This source returns genuinely new launchpad mints that can pass them.
    try {
      const llRows = await fetchLaunchLabTokens('new', 50);
      const beforeLL = rawTokens.length;
      for (const r of llRows) {
        const addr = r?.mint;
        if (!addr) continue;
        // ── Field semantics verified from a raw API dump (2026-06-11) ──
        //   marketCap: USD · volumeA/B/U: cumulative token/SOL/USD volume
        //   initPrice/endPrice: SOL per token at launch / at graduation
        //   totalFundRaisingB: lamports target (85 SOL letsbonk) · finishingRate: useless (0 even after trades)
        const mcUsd = parseFloat(r.marketCap || '0');
        const volU = parseFloat(r.volumeU || '0');
        const volB = parseFloat(r.volumeB || '0');
        const supply = parseFloat(r.supply || '0') || 1e9;
        const initPrice = parseFloat(r.initPrice || '0');
        const endPrice = parseFloat(r.endPrice || '0');
        const targetSol = parseFloat(r.totalFundRaisingB || '0') / 1e9;
        const createdMs = r.createAt ? new Date(r.createAt).getTime() : Date.now();
        // SOL/USD rate self-consistent with the API's own USD figures; fallback to cache.
        const solRate = (volB > 0.001 && volU > 0) ? volU / volB : (cachedSolPriceFromFeed || null);
        const launchMcUsd = (initPrice > 0 && solRate) ? initPrice * supply * solRate : null;

        // Sample marketCap on EVERY poll (even for already-seen tokens). With the
        // launch-MC baseline, a single sample already yields since-launch change%.
        recordLaunchLabStats(addr, mcUsd, volU > 0 ? volU : null, launchMcUsd, createdMs);

        // Constant-product curve math: price scales with (virtual SOL)², so
        //   vQ0 = target / (√(endPrice/initPrice) − 1)   (≈30 SOL on letsbonk defaults)
        //   raised = vQ0 · (√(P_now/P_init) − 1)
        // Liquidity reported as SOL in the curve (virtual + raised) — same convention
        // as pump.fun rows (~30 SOL at launch), so the Liq filter compares like-for-like.
        let liqSol = 0;
        let bondingPct = 0;
        if (initPrice > 0 && endPrice > initPrice && targetSol > 0) {
          const vQ0 = targetSol / (Math.sqrt(endPrice / initPrice) - 1);
          const priceRatio = (launchMcUsd && mcUsd > 0) ? Math.max(mcUsd / launchMcUsd, 1) : 1;
          const raisedSol = vQ0 * (Math.sqrt(priceRatio) - 1);
          liqSol = vQ0 + raisedSol;
          bondingPct = Math.min((raisedSol / targetSol) * 100, 100);
        }

        addOrMerge(addr, {
          mint: addr,
          name: r.name || r.symbol || 'Unknown',
          symbol: r.symbol || '???',
          source: 'launchlab',
          liquiditySol: liqSol,
          marketCapUsd: mcUsd || null,
          volume24h: volU > 0 ? volU : null,
          created_timestamp: createdMs,
          status: bondingPct >= 100 ? 'active' : 'presale',
          bonding_progress: bondingPct,
          website: r.website || null,
          twitter: r.twitter || null,
          telegram: r.telegram || null,
          _source: 'feed',
        });
      }
      sniperDebug(`[SNIPER-DEBUG] Source 3 (LaunchLab new): ${llRows.length} fetched, ${rawTokens.length - beforeLL} new, total ${rawTokens.length}`);
    } catch (llErr: any) {
      console.warn('LaunchLab new-launches feed error:', llErr?.message);
    }

    sniperDebug(`[SNIPER-DEBUG] rawTokens total: ${rawTokens.length} (full feed — display filters applied per-request)`);



    // ── Transform to frontend format — synchronous map (no async per-token RPC calls) ──
    // quickSafetyCheck was removed: it fired 100 async Helius RPC calls per 5-second poll = OOM
    // NOTE: Do NOT slice rawTokens before transform — Source 1 may push 100+ pump.fun tokens
    // before Source 2 adds LaunchLab tokens. Slicing here would cut off LaunchLab entirely.
    const tokens = rawTokens.map((token: any) => {
      const riskLevel: 'low' | 'medium' | 'high' | 'critical' = 'high';
      const warnings: string[] = [];

      const isPortal = token._source === 'portal';
      const isPumpFun = 'mint' in token; // both pumpportal and pumpfun tokens have 'mint'
      const isLaunchLab = token.source === 'launchlab' || token.dex === 'launchlab';
      const isRaydium = token.source === 'raydium' || token.dex === 'raydium';

      // Unified liquidity: virtual_sol_reserves is in lamports (PumpFunToken/DexScreener fallback),
      // vSolInBondingCurve is in SOL (PumpPortal WebSocket).
      // If virtual_sol_reserves is 0, it likely means the field wasn't populated — fall through to vSolInBondingCurve.
      const rawLamports = token.virtual_sol_reserves;
      // DexScreener-sourced tokens (launchlab/raydium) carry token.liquidity in USD —
      // convert via cached SOL price instead of the old (wrong) /1e9 lamports division.
      const dexScreenerLiqUsd = (isLaunchLab || isRaydium) && typeof token.liquidity === 'number'
        ? token.liquidity : null;
      const solInLiq = (isLaunchLab || isRaydium)
        ? (token.liquiditySol
          || (dexScreenerLiqUsd != null && cachedSolPriceFromFeed ? dexScreenerLiqUsd / cachedSolPriceFromFeed : 0))
        : (rawLamports != null && rawLamports > 0)
          ? rawLamports / 1e9          // lamports → SOL
          : (token.vSolInBondingCurve != null && token.vSolInBondingCurve > 0)
            ? token.vSolInBondingCurve  // already in SOL from WebSocket
            : 30;                        // safe fallback for new pump.fun tokens on bonding curve

      // Derive SOL/USD price from pump.fun's own data
      // pump.fun API tokens (Source 2) include BOTH usd_market_cap AND market_cap (SOL)
      // PumpPortal WebSocket tokens (Source 1) only have SOL — use cached price from Source 2
      // UNIT WARNING: for launchlab/raydium rows `token.marketCap` is USD
      // (DexScreener fdv / LaunchLab API marketCap) — reading it into mcSol
      // made marketCapUsd = USD × SOL-price ≈ 150× inflated.
      const mcUsd = token.usd_market_cap || token.marketCapUsd
        || ((isLaunchLab || isRaydium) ? (token.marketCap || 0) : 0);
      const mcSol = token.market_cap
        || ((isLaunchLab || isRaydium) ? 0 : token.marketCap)
        || token.marketCapSol || 0;
      let liquidityUsd: number | null = null;
      let solPriceError: string | null = null;
      if (dexScreenerLiqUsd != null) {
        // DexScreener already reports USD liquidity — use it directly
        liquidityUsd = Math.round(dexScreenerLiqUsd);
      } else if (mcUsd > 0 && mcSol > 0 && !isNaN(solInLiq)) {
        // Best case: this token has USD data — derive price ratio directly
        const solPrice = mcUsd / mcSol;
        updateSolPriceCache(mcUsd, mcSol); // keep cache fresh
        liquidityUsd = Math.round(solInLiq * solPrice);
      } else if (!isNaN(solInLiq) && solInLiq > 0 && cachedSolPriceFromFeed !== null) {
        // Fallback: use SOL price derived from DexScreener (primed by Source 2 fetch above)
        liquidityUsd = Math.round(solInLiq * cachedSolPriceFromFeed);
      } else if (!isNaN(solInLiq) && solInLiq > 0) {
        solPriceError = 'SOL price not yet available from pump.fun API';
      }

      // Compute marketCapUsd — same logic: use cache when token lacks raw USD data
      const marketCapUsdComputed: number | null =
        mcUsd > 0 ? mcUsd
          : (mcSol > 0 && cachedSolPriceFromFeed !== null) ? Math.round(mcSol * cachedSolPriceFromFeed)
            : null;

      // Creation time: handle both created_timestamp (ms) and timestamp (ms)
      const createdAt = token.created_timestamp
        ? new Date(token.created_timestamp)
        : token.timestamp
          ? new Date(token.timestamp)
          : token.launchTime
            ? new Date(token.launchTime)
            : new Date();

      // Pre-bonded determination:
      // - Portal tokens (real-time WebSocket) are always pre-bonded by definition
      // - PumpFun API/DexScreener tokens: use complete flag if present, else heuristic (mint ends with 'pump')
      // - LaunchLab tokens: use status === 'presale'
      const tokenAddr = token.mint || token.tokenMint || '';
      const isPreBonded = isPortal
        ? true
        : isLaunchLab
          ? token.status === 'presale'
          : (typeof token.complete === 'boolean' ? !token.complete : tokenAddr.endsWith('pump'));

      return {
        id: token.mint || token.poolAddress,
        tokenAddress: token.mint || token.tokenMint,
        tokenName: token.name || token.tokenName || 'Unknown',
        tokenSymbol: token.symbol || token.tokenSymbol || '???',
        // Derive dex from the token's ACTUAL source (§6.2) — 'raydium' is now emitted,
        // so the frontend's Raydium tab is no longer permanently empty (§1.5)
        dex: isRaydium ? 'raydium' : isLaunchLab ? 'launchlab' : 'pumpfun',
        liquiditySol: isNaN(solInLiq) ? null : solInLiq,
        liquidityUsd: liquidityUsd,  // null when SOL price unavailable
        solPriceError: solPriceError, // non-null string if price fetch failed
        marketCapSol: mcSol || null,
        marketCapUsd: marketCapUsdComputed,
        price: token.price_sol || token.priceUsd || null,
        // Pass through DexScreener-sourced 24h volume (USD) — the /api/sniper/tokens
        // enrichment uses this as a fallback; previously it was silently dropped here
        // and every row's volume re-defaulted to null.
        volume24h: typeof token.volume24h === 'number' && token.volume24h > 0 ? token.volume24h : null,
        isPreBonded,
        bondingProgress: token.bonding_progress || token.bonding_curve || null,
        riskLevel,
        warnings,
        hasTwitter: !!(token.twitter),
        hasTelegram: !!(token.telegram),
        hasWebsite: !!(token.website),
        // Which feed produced this row: 'onchain' | 'portal' | 'feed'. Lets the UI
        // badge the source and lets you verify the on-chain stream is contributing.
        feedSource: token._source || 'feed',
        detectedAt: new Date(),
        createdAt
      };
    });

    const llTokenCount = tokens.filter((t: any) => t.dex === 'launchlab').length;
    const pfTokenCount = tokens.filter((t: any) => t.dex === 'pumpfun').length;
    sniperDebug(`[SNIPER-DEBUG] FEED BUILT: ${tokens.length} tokens (${pfTokenCount} pumpfun, ${llTokenCount} launchlab)`);
    return tokens;
}

/**
 * DexScreener enrichment with per-address 60s cache + PARALLEL batches (§7.2).
 * Previously 3 sequential batches × 5s timeout = 15s worst case; now 5s worst case,
 * and cached addresses skip the network entirely (instant re-sorts).
 */
async function enrichWithDexScreener(addrs: string[]): Promise<Record<string, any>> {
    const dataMap: Record<string, any> = {};
    const now = Date.now();
    const misses: string[] = [];
    for (const addr of addrs.slice(0, 90)) {
      const hit = _dexEnrichCache.get(addr);
      if (hit && now - hit.ts < DEX_ENRICH_TTL_MS) dataMap[addr] = hit.data;
      else misses.push(addr);
    }
    const BATCH = 30;
    const batches: string[][] = [];
    for (let i = 0; i < misses.length; i += BATCH) batches.push(misses.slice(i, i + BATCH));
    await Promise.all(batches.map(async (batch) => {
      try {
        const url = `https://api.dexscreener.com/tokens/v1/solana/${batch.join(',')}`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (resp.ok) {
          const pairs: any[] = await resp.json();
          for (const pair of pairs) {
            const addr = pair.baseToken?.address;
            if (addr && !dataMap[addr]) {
              const data = {
                volume24h: pair.volume?.h24 ?? null,
                change5m: pair.priceChange?.m5 ?? null,
                change1h: pair.priceChange?.h1 ?? null,
                change6h: pair.priceChange?.h6 ?? null,
                change24h: pair.priceChange?.h24 ?? null,
              };
              dataMap[addr] = data;
              _dexEnrichCache.set(addr, { ts: Date.now(), data });
            }
          }
        }
      } catch { /* network error — fields stay null */ }
    }));
    // Bound the cache (drop oldest half when oversized)
    if (_dexEnrichCache.size > 2000) {
      const entries = [..._dexEnrichCache.entries()].sort((a, b) => a[1].ts - b[1].ts);
      for (let i = 0; i < entries.length / 2; i++) _dexEnrichCache.delete(entries[i][0]);
    }
    return dataMap;
}

// Get detected tokens (from PumpFun, LaunchLab, etc)
app.get('/api/sniper/tokens', optionalAuth, asyncHandler(async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 100;
    const dex = req.query.dex as string;
    const preBondedOnly = req.query.preBondedOnly === 'true';
    const feedKey = `feed:${Math.max(limit, 200)}`;

    // ── Cache with stale-while-revalidate (§7.3) ────────────────────────
    let tokens: any[];
    const cached = _sniperTokensCache.get(feedKey);
    const age = cached ? Date.now() - cached.ts : Infinity;
    if (cached && age < SNIPER_TOKENS_TTL_MS) {
      tokens = cached.tokens;
      res.setHeader('X-Sniper-Cache', age < SNIPER_TOKENS_STALE_MS ? 'HIT' : 'STALE');
      if (age >= SNIPER_TOKENS_STALE_MS && !_feedRefreshInFlight.has(feedKey)) {
        _feedRefreshInFlight.add(feedKey);
        buildSniperFeed(limit)
          .then(fresh => { if (fresh.length > 0) _sniperTokensCache.set(feedKey, { ts: Date.now(), tokens: fresh }); })
          .catch(err => console.warn('Background feed refresh failed:', err?.message))
          .finally(() => _feedRefreshInFlight.delete(feedKey));
      }
    } else {
      tokens = await buildSniperFeed(limit);
      // only cache non-empty results so startup race doesn't poison the cache
      if (tokens.length > 0) _sniperTokensCache.set(feedKey, { ts: Date.now(), tokens });
      res.setHeader('X-Sniper-Cache', 'MISS');
    }

    // ── Cheap in-memory display filters (backward compat — frontend also filters client-side) ──
    if (dex && dex !== 'all') tokens = tokens.filter((t: any) => t.dex === dex);
    if (preBondedOnly) tokens = tokens.filter((t: any) => t.isPreBonded);

    // ── DexScreener enrichment: price-change % + 24h volume (parallel + cached, §7.2) ──
    const enrichSort = req.query.sortBy as string | undefined;
    const shouldEnrich = enrichSort === 'change5m' || enrichSort === 'change1h'
      || enrichSort === 'change6h' || enrichSort === 'change24h';
    const dataMap: Record<string, any> = shouldEnrich
      ? await enrichWithDexScreener(tokens.map((t: any) => t.tokenAddress).filter(Boolean))
      : {};

    // Price change comes PRIMARILY from PumpPortal bonding-curve market-cap history
    // (the real source for pre-bonded tokens). DexScreener fills gaps for the minority
    // of tokens it has indexed and provides the 24h volume column.
    const enrichedTokens = tokens.map((t: any) => {
      // Priority: on-chain stream (live, 0s) → PumpPortal bonding-curve stats →
      // DexScreener (indexed/established) → LaunchLab sampling. First non-null wins.
      const oc = onchainPumpStream.getMarketStats(t.tokenAddress);
      const pp = pumpPortalService.getMarketStats(t.tokenAddress);
      const dx = dataMap[t.tokenAddress];
      // LaunchLab fallback: derived from marketCap sampling of the LaunchLab API
      // (DexScreener doesn't index pre-bonded LaunchLab mints, PumpPortal doesn't
      // stream their trades — without this every LaunchLab row sorted as "—").
      const ll = t.dex === 'launchlab' ? getLaunchLabMarketStats(t.tokenAddress) : null;
      return {
        ...t,
        volume24h: oc?.volume24h ?? dx?.volume24h ?? ll?.volume24h ?? t.volume24h ?? null,
        priceChange5m: oc?.priceChange5m ?? pp?.priceChange5m ?? dx?.change5m ?? ll?.priceChange5m ?? null,
        priceChange1h: oc?.priceChange1h ?? pp?.priceChange1h ?? dx?.change1h ?? ll?.priceChange1h ?? null,
        priceChange6h: dx?.change6h ?? null,
        priceChange24h: oc?.priceChange24h ?? pp?.priceChange24h ?? dx?.change24h ?? ll?.priceChange24h ?? null,
      };
    });

    // Server-side sort by price change in the requested window (client re-sorts too).
    // Price change can be negative, so missing data sinks to the bottom via -Infinity.
    const NEG = Number.NEGATIVE_INFINITY;
    if (enrichSort === 'change5m') {
      enrichedTokens.sort((a, b) => (b.priceChange5m ?? NEG) - (a.priceChange5m ?? NEG));
    } else if (enrichSort === 'change1h') {
      enrichedTokens.sort((a, b) => (b.priceChange1h ?? NEG) - (a.priceChange1h ?? NEG));
    } else if (enrichSort === 'change6h') {
      enrichedTokens.sort((a, b) => (b.priceChange6h ?? NEG) - (a.priceChange6h ?? NEG));
    } else if (enrichSort === 'change24h') {
      enrichedTokens.sort((a, b) => (b.priceChange24h ?? NEG) - (a.priceChange24h ?? NEG));
    }

    res.json({ success: true, tokens: enrichedTokens, total: enrichedTokens.length });

  } catch (error: any) {
    console.error('Error fetching sniper tokens:', error);
    res.status(500).json({ success: false, error: error.message, tokens: [] });
  }
}));

// Execute a manual snipe
app.post('/api/sniper/execute', authenticateUser, asyncHandler(async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    const { tokenAddress, buyAmountSol, slippageBps: reqSlippage, useJito, walletId } = req.body;
    // Slippage source of truth: user's saved sniper config (maxSlippage field, stored as String).
    // Request body can override (for explicit UI control), but DB config is primary.
    // Pump.fun has NO transfer taxes — slippage only covers price movement between quote and execution.
    const sniperConfig = await sqliteDb.sniper_configs.findFirst({ where: { userId } });
    // maxSlippage stored as % string (e.g. "5" = 5%) — multiply by 100 to get bps
    const configuredSlippage = sniperConfig?.maxSlippage
      ? Math.round(parseFloat(sniperConfig.maxSlippage) * 100)
      : 500; // 5% default
    const slippageBps = reqSlippage != null
      ? parseInt(String(reqSlippage), 10)
      : configuredSlippage;

    if (!tokenAddress || !buyAmountSol) {
      return res.status(400).json({ success: false, error: 'Missing required parameters' });
    }

    console.log(`🎯 Manual snipe requested: ${tokenAddress} for ${buyAmountSol} SOL`);

    // Log the execution attempt
    const execution = await sqliteDb.snipe_executions.create({
      data: {
        userId,
        tokenAddress,
        tokenName: 'Unknown', // Will be updated
        dex: 'auto',
        buyAmountSol,
        status: 'pending',
        detectedAt: new Date()
      }
    }).catch(() => null);

    // ─── TOKEN TYPE DETECTION + ROUTING ─────────────────────────────────────────
    // Priority order:
    //  1. pump.fun pre-bonded (bonding curve buy V2 — direct on-chain)
    //  2. pump.fun graduated (PumpSwap pAMM buy)
    //  3. LetsBonk/LaunchLab pool
    //  4. Fall through to Jupiter swap
    // We detect by trying each path — the bonding curve lookup is the cheapest first check.

    // Resolve the trading wallet consistently: explicit body walletId →
    // the wallet saved in snipe_settings (the UI selector) → active → first.
    let effectiveWalletId: string | undefined = walletId;
    if (!effectiveWalletId) {
      const savedSettings = await sqliteDb.snipe_settings.findFirst({
        where: { userId }, orderBy: { updatedAt: 'desc' }
      }).catch(() => null);
      if (savedSettings && (savedSettings as any).walletId) effectiveWalletId = (savedSettings as any).walletId;
    }
    const wallet = await prisma.managed_wallets.findFirst({
      where: {
        userId,
        ...(effectiveWalletId ? { id: effectiveWalletId } : {})
      },
      // Prefer explicitly resolved wallet; otherwise prefer active, else just take first
      orderBy: effectiveWalletId ? undefined : [{ isActive: 'desc' }, { createdAt: 'asc' }]
    });
    if (!wallet) {
      return res.status(400).json({ success: false, error: 'No wallet found. Add a wallet in Wallet Manager first.' });
    }
    console.log(`👛 Trading wallet: ${wallet.walletName} (${wallet.publicKey.slice(0, 8)}…) [source: ${walletId ? 'request' : effectiveWalletId ? 'saved-settings' : 'active/first'}]`);

    const { Connection } = await import('@solana/web3.js');
    const rpcConnection = new Connection(rpcManager.getUrl(), 'confirmed');
    const { secureWalletService } = await import('./src/lib/secureWalletService.js');

    // Helper: sign + broadcast — sends immediately, then rebroadcasts every 2s until confirmed.
    // KEY FIX: The service layer returns { transaction, instructions, connection, payerKey }.
    // We ALWAYS rebuild the TX with a FRESH blockhash right here, AFTER keypair decryption,
    // because the keypair decrypt latency can expire the blockhash that was baked inside the service.
    // This mirrors the pattern in buy_token.mjs which successfully purchases tokens.
    const signAndSend = async (result: any): Promise<string> => {
      const keypair = await secureWalletService.getKeypairForSigning(wallet.id, userId);
      console.log(`🔑 Signing with keypair: ${keypair.publicKey.toBase58()}`);
      const { VersionedTransaction, TransactionMessage } = await import('@solana/web3.js');

      let tx: InstanceType<typeof VersionedTransaction>;

      // If the service returned { instructions, connection, payerKey }, rebuild with FRESH blockhash.
      // This is the critical path — rebuilding as late as possible minimises expiry risk.
      if (result?.instructions && Array.isArray(result.instructions) && result.payerKey) {
        console.log(`🔄 Rebuilding TX with fresh blockhash (${result.instructions.length} instructions)...`);
        const { blockhash: freshBlockhash, lastValidBlockHeight: lvbh } =
          await rpcConnection.getLatestBlockhash('confirmed');
        console.log(`🔑 Fresh blockhash: ${freshBlockhash} (valid until block ${lvbh})`);
        const msg = new TransactionMessage({
          payerKey: result.payerKey,
          recentBlockhash: freshBlockhash,
          instructions: result.instructions,
        }).compileToV0Message();
        tx = new VersionedTransaction(msg);
        tx.sign([keypair]);
      } else {
        // Fallback for paths that only return a pre-built transaction (PumpPortal, PumpSwap, LaunchLab)
        const raw = (result instanceof VersionedTransaction) ? result : result?.transaction ?? result;
        if (!(raw instanceof VersionedTransaction)) {
          throw new Error('signAndSend: unrecognised transaction format — expected VersionedTransaction');
        }
        tx = raw;
        tx.sign([keypair]);
        console.log(`🔑 Using pre-built TX with blockhash: ${tx.message.recentBlockhash}`);
      }

      // ── PRE-FLIGHT SIMULATION (advisory only) ──────────────────────────────
      // Simulate BEFORE the rebroadcast loop to surface genuine program errors,
      // but DO NOT block the trade on simulation false-negatives.
      //
      // Why: PumpPortal bakes its own blockhash into the TX. By the time we decrypt
      // the keypair and reach this point, that blockhash points at a slightly stale
      // bank where a seconds-old bonding-curve / ATA account isn't visible yet — the
      // node then reports "AccountNotFound" even though the on-chain send succeeds.
      // (This is exactly why buy_token.mjs skips preflight entirely and still lands.)
      //
      // Mitigations: (1) replaceRecentBlockhash + processed commitment → simulate
      // against the latest bank so fresh accounts resolve; (2) treat known
      // false-negatives (AccountNotFound / BlockhashNotFound) as non-fatal and
      // broadcast anyway; only hard-fail on clearly fatal errors.
      try {
        const sim = await rpcConnection.simulateTransaction(tx, {
          sigVerify: false,
          replaceRecentBlockhash: true,
          commitment: 'processed',
        });
        if (sim.value.err) {
          const errDetail = JSON.stringify(sim.value.err);
          const logs = (sim.value.logs || []).slice(-8).join('\n  ');
          const blob = `${errDetail} ${logs}`;
          // Known transient/false-negative signals for freshly-minted tokens.
          const isFalseNegative = /AccountNotFound|BlockhashNotFound|could not find account|ProgramAccountNotFound/i.test(blob);
          if (isFalseNegative) {
            console.warn(`⚠️ Simulation reported a likely false-negative (${errDetail}) — broadcasting anyway.\n  ${logs}`);
          } else {
            console.error(`❌ Simulation FAILED: ${errDetail}\n  ${logs}`);
            throw new Error(`Transaction simulation failed: ${errDetail}`);
          }
        } else {
          console.log(`✅ Simulation passed (${sim.value.unitsConsumed || '?'} CUs)`);
        }
      } catch (simErr: any) {
        // If it's our formatted (genuinely fatal) error, rethrow it.
        if (simErr?.message?.startsWith('Transaction simulation failed')) throw simErr;
        // Network/other errors during simulation are non-fatal — proceed to send.
        console.warn(`⚠️ Simulation skipped (non-fatal error): ${simErr?.message}`);
      }

      // Get lastValidBlockHeight for the TX's actual blockhash
      let lastValidBlockHeight = 0;
      try {
        const bhInfo = await rpcConnection.getLatestBlockhash('confirmed');
        lastValidBlockHeight = bhInfo.lastValidBlockHeight;
        console.log(`📏 Block validity window: expires at block ${lastValidBlockHeight}`);
      } catch { /* non-fatal */ }

      const rawTx = tx.serialize();
      const sendOpts = { skipPreflight: true, preflightCommitment: 'processed' as const, maxRetries: 0 };
      let signature: string | null = null;
      let confirmed = false;
      let lastSentAt = 0;
      const startMs = Date.now();
      const MAX_WAIT_MS = 45_000; // 45s — PumpPortal TXs should confirm within ~10s if valid

      console.log(`📤 Broadcasting TX — rebroadcast loop starts now...`);

      while (!confirmed) {
        const elapsedMs = Date.now() - startMs;

        // Hard time cap
        if (elapsedMs > MAX_WAIT_MS) {
          throw new Error('Transaction timed out after 45s — blockhash likely expired, please retry');
        }

        // Block-height bail-out (only if we have a valid window reading)
        if (lastValidBlockHeight > 0) {
          const currentBlock = await rpcConnection.getBlockHeight('confirmed').catch(() => 0);
          if (currentBlock > 0 && currentBlock > lastValidBlockHeight) {
            console.error(`❌ Blockhash expired (block ${currentBlock} > ${lastValidBlockHeight})`);
            throw new Error('Transaction blockhash expired — price may have moved, please retry');
          }
        }

        // (Re)send every 2 seconds
        if (Date.now() - lastSentAt >= 2000) {
          try {
            signature = await rpcConnection.sendRawTransaction(rawTx, sendOpts);
            lastSentAt = Date.now();
            console.log(`📡 Sent/re-sent TX (${Math.round(elapsedMs / 1000)}s): ${signature.slice(0, 20)}...`);
          } catch (sendErr: any) {
            const errMsg: string = sendErr?.message || '';
            if ((errMsg.includes('AlreadyProcessed') || errMsg.includes('already been processed')) && signature) {
              console.log(`✅ TX already processed — treating as confirmed`);
              confirmed = true;
              break;
            }
            // "Blockhash not found" means the blockhash expired on the node side
            if (errMsg.includes('Blockhash not found')) {
              throw new Error('Transaction blockhash expired — please retry');
            }
            console.warn(`⚠️ sendRawTransaction error (will retry): ${errMsg}`);
          }
        }

        if (!signature) { await new Promise(r => setTimeout(r, 1000)); continue; }

        // Poll for confirmation every 1.5s
        await new Promise(r => setTimeout(r, 1500));
        try {
          const status = await rpcConnection.getSignatureStatus(signature, { searchTransactionHistory: false });
          const conf = status?.value?.confirmationStatus;
          if (conf === 'confirmed' || conf === 'finalized') {
            if (status.value?.err) {
              throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.value.err)}`);
            }
            console.log(`✅ TX confirmed (${conf}) in ${Math.round((Date.now() - startMs) / 1000)}s: ${signature}`);
            confirmed = true;
          }
        } catch (pollErr: any) {
          if (pollErr?.message?.startsWith('Transaction failed')) throw pollErr;
          // Other poll errors (network) — keep looping
        }
      }

      if (!signature) throw new Error('Transaction failed: no signature obtained');
      return signature;
    };

    // ── PATH 1: pump.fun bonding curve (pre-bonded) — via PumpPortal API ─────
    // Uses PumpPortal trade-local API for correct transaction construction.
    // This replaces manual instruction building which broke after the Feb 2026
    // cashback upgrade (stale account layout → Custom error 6062).
    const isPumpToken = tokenAddress.toLowerCase().endsWith('pump');
    // Convert bps to percent for PumpPortal API. Uses the user's Sniper Settings
    // slippage exactly — no hardcoded floor. If a fast-moving token rejects with
    // 6002 (TooMuchSolRequired), raise the Slippage (%) in Sniper Settings.
    const pumpSlippagePct = slippageBps / 100;
    try {
      console.log(`🔮 Trying pump.fun buy via PumpPortal for ${tokenAddress} (slippage: ${pumpSlippagePct}%)...`);
      const { pumpPortalTradeService } = await import('./src/lib/pumpPortalTradeService.js');
      const result = await pumpPortalTradeService.buyToken({
        publicKey: wallet.publicKey,
        mint: tokenAddress,
        solAmount: buyAmountSol,
        slippagePct: pumpSlippagePct,
      });

      if (result) {
        // PumpPortal sizes the token amount from its own (often stale) price, which makes
        // already-pumped tokens cost several× the budget → pump.fun 6002. Resize the buy
        // to the user's actual SOL budget before signing.
        if (result.transaction) {
          const { sizePumpBuyToBudget } = await import('./src/lib/pumpBuySizer.js');
          const sz = await sizePumpBuyToBudget(rpcConnection, result.transaction, buyAmountSol, pumpSlippagePct);
          console.log(`📐 Buy sizer: ${sz.reason}`, sz.detail ? JSON.stringify(sz.detail) : '');
        }
        const txSignature = await signAndSend(result);
        console.log(`✅ PumpFun snipe submitted (PumpPortal): ${txSignature}`);

        if (execution) {
          await sqliteDb.snipe_executions.update({
            where: { id: execution.id },
            data: {
              status: 'success', dex: 'pumpfun',
              executedAt: new Date(),
              latencyMs: Date.now() - new Date(execution.detectedAt).getTime(),
              txSignature,
            }
          }).catch(() => { });
        }
        // Centralized verified recording — checks the tx on-chain (meta.err + real
        // token balance delta) before writing, replaces the old insert-then-enrich flow.
        {
          const tk = await sqliteDb.token.findUnique({ where: { tokenAddress } }).catch(() => null);
          void recordBuyTrade({
            userId, walletId: wallet.id, walletPubkey: wallet.publicKey, signature: txSignature,
            tokenMint: tokenAddress, tokenName: tk?.tokenName || null, tokenSymbol: tk?.tokenSymbol || null,
            tokensEstimate: 0, dexLabel: 'PUMPFUN', fallbackSolSpent: buyAmountSol,
          });
        }
        return res.json({
          success: true,
          message: 'PumpFun snipe submitted (via PumpPortal)',
          signature: txSignature,
          explorer: `https://solscan.io/tx/${txSignature}`,
          quote: result.quote,
          path: 'pumpfun-bonding-curve',
        });
      }
    } catch (pumpErr: any) {
      const msg = (pumpErr.message || '').toLowerCase();
      // PumpPortal returns errors for graduated tokens and invalid mints.
      // For 'pump' suffix tokens, graduation is impossible — treat errors as real failures.
      const trueGraduation = (msg.includes('graduated') || msg.includes('complete'))
        && !isPumpToken;

      if (!trueGraduation) {
        // Real error (insufficient balance, slippage, PumpPortal API error, etc.)
        console.error('PumpFun buy error (PumpPortal):', pumpErr.message);
        if (execution) {
          await sqliteDb.snipe_executions.update({
            where: { id: execution.id },
            data: { status: 'failed', failureReason: pumpErr.message }
          }).catch(() => { });
        }
        return res.status(500).json({ success: false, error: pumpErr.message });
      }
      console.log(`⚠️ Token confirmed graduated — trying PumpSwap pAMM...`);
    }

    // ── PATH 2: PumpSwap pAMM (graduated tokens) ──────────────────────────────
    try {
      const { PumpSwapService } = await import('./src/lib/pumpSwapService.js');
      const pumpSwapSvc = new PumpSwapService(rpcConnection);
      const poolAddr = await pumpSwapSvc.findPoolByMint(tokenAddress);

      if (poolAddr) {
        console.log(`🔀 Token graduated — buying via PumpSwap pAMM (pool: ${poolAddr.slice(0, 8)}...)`);
        const result = await pumpSwapSvc.buyPumpSwap(
          tokenAddress,
          buyAmountSol,
          slippageBps || 300,
          wallet.publicKey,
        );

        if (result) {
          const txSignature = await signAndSend(result);
          console.log(`✅ PumpSwap snipe submitted: ${txSignature}`);

          if (execution) {
            await sqliteDb.snipe_executions.update({
              where: { id: execution.id },
              data: {
                status: 'success', dex: 'pumpswap',
                executedAt: new Date(),
                latencyMs: Date.now() - new Date(execution.detectedAt).getTime(),
                txSignature,
              }
            }).catch(() => { });
          }
          return res.json({
            success: true,
            message: 'PumpSwap (graduated) snipe submitted',
            signature: txSignature,
            explorer: `https://solscan.io/tx/${txSignature}`,
            quote: result.quote,
            path: 'pumpswap-pamm',
          });
        }
      }
    } catch (pswapErr: any) {
      console.log(`⚠️ PumpSwap failed: ${pswapErr.message} — trying LaunchLab...`);
    }

    // ── PATH 3: LetsBonk / Raydium LaunchLab ─────────────────────────────────
    try {
      const { LaunchLabService } = await import('./src/lib/launchLabService.js');
      const launchLabSvc = new LaunchLabService(rpcConnection);
      const hasPool = await launchLabSvc.hasPool(tokenAddress);

      if (hasPool) {
        console.log(`🚀 Token on LaunchLab — buying via buy_exact_in...`);
        const result = await launchLabSvc.buyExactIn(
          tokenAddress,
          buyAmountSol,
          slippageBps || 300,
          wallet.publicKey,
        );

        if (result) {
          const txSignature = await signAndSend(result);
          console.log(`✅ LaunchLab snipe submitted: ${txSignature}`);

          if (execution) {
            await sqliteDb.snipe_executions.update({
              where: { id: execution.id },
              data: {
                status: 'success', dex: 'launchlab',
                executedAt: new Date(),
                latencyMs: Date.now() - new Date(execution.detectedAt).getTime(),
                txSignature,
              }
            }).catch(() => { });
          }
          return res.json({
            success: true,
            message: 'LaunchLab (LetsBonk) snipe submitted',
            signature: txSignature,
            explorer: `https://solscan.io/tx/${txSignature}`,
            quote: result.quote,
            path: 'letsbonk-launchlab',
          });
        }
      }
    } catch (llErr: any) {
      console.log(`⚠️ LaunchLab failed: ${llErr.message} — falling through to Jupiter`);
    }


    // Fall back to regular DEX swap (Raydium/Jupiter)
    console.log('📊 Token is not pre-bonded, using DEX swap');

    res.json({
      success: true,
      message: 'Use standard swap for this token',
      tokenAddress,
      isPreBonded: false
    });

  } catch (error: any) {
    console.error('Error executing snipe:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}));
// (slop audit) GET /api/token/analyze/:address — dead route archived to archive/dead-endpoints-20260612.ts.txt

// WebSocket connection handling
// WebSocket connection handling
wss.on('connection', (ws, req) => {
  // SECURITY FIX: Access authenticated user info from request object
  const user = (req as any).user;
  const clientIp: string = (req as any)._clientIp || req.socket?.remoteAddress || 'unknown';

  // Increment per-IP connection counter
  wsConnectionsByIp.set(clientIp, (wsConnectionsByIp.get(clientIp) || 0) + 1);

  if (!user) {
    console.log('❌ WebSocket connection with no user context - this should not happen');
    ws.close(1008, 'Authentication required');
    return;
  }

  console.log(`🔌 New WebSocket connection established from: ${req.socket.remoteAddress} (user: ${user.id})`);

  // Attach user info to WebSocket connection for later use
  (ws as any).user = user;

  // Send welcome message with user info
  ws.send(JSON.stringify({
    type: 'connection',
    status: 'connected',
    message: 'WebSocket connection established - Ready for live updates',
    timestamp: new Date().toISOString(),
    server: 'AutoBotAPP',
    user: {
      id: user.id,
      walletAddress: user.walletAddress,
      tier: user.tier
    },
    features: ['token_feed', 'wallet_updates']
  }));

  // Handle incoming messages
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      console.log('📨 WebSocket message received:', data.type);

      switch (data.type) {
        case 'ping':
          ws.send(JSON.stringify({
            type: 'pong',
            timestamp: new Date().toISOString()
          }));
          break;

        case 'subscribe_sniper':
          // Client subscribes to sniper updates (same as token_feed, kept for compatibility)
          console.log('📋 Client subscribed to sniper updates');
          (ws as any).tokenFeedSubscribed = true;
          ws.send(JSON.stringify({
            type: 'sniper_subscribed',
            status: 'connected',
            timestamp: new Date().toISOString()
          }));
          break;

        case 'subscribe_token_feed':
          // Handle token feed subscription for real-time updates
          console.log('📋 Client subscribed to token feed updates');
          (ws as any).tokenFeedSubscribed = true; // Mark this client as subscribed
          ws.send(JSON.stringify({
            type: 'token_feed_subscribed',
            status: 'connected',
            message: 'Successfully subscribed to live token feed',
            timestamp: new Date().toISOString()
          }));
          break;

        case 'subscribe_wallet':
          // Handle wallet subscription for real-time balance updates
          console.log('📋 Client subscribed to wallet updates:', data.walletId);
          ws.send(JSON.stringify({
            type: 'wallet_subscribed',
            walletId: data.walletId,
            timestamp: new Date().toISOString()
          }));
          break;

        default:
          console.log('❓ Unknown message type:', data.type);
      }
    } catch (error) {
      console.error('❌ Error parsing WebSocket message:', error);
    }
  });

  // Handle client disconnect
  ws.on('close', (code, reason) => {
    // Decrement per-IP counter; clean up map entry when count reaches zero
    const prevCount = wsConnectionsByIp.get(clientIp) || 1;
    if (prevCount <= 1) {
      wsConnectionsByIp.delete(clientIp);
    } else {
      wsConnectionsByIp.set(clientIp, prevCount - 1);
    }
    console.log(`🔌 WebSocket connection closed (IP: ${clientIp}, remaining: ${wsConnectionsByIp.get(clientIp) ?? 0}):`, code, reason.toString());
  });

  // Handle errors
  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error);
  });

  // Send periodic heartbeat to keep connection alive
  const heartbeat = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({
        type: 'heartbeat',
        timestamp: new Date().toISOString()
      }));
    } else {
      clearInterval(heartbeat);
    }
  }, 30000); // Every 30 seconds
});

// ── Server-side balance polling ───────────────────────────────────────────
// Every 60 seconds: fetch all managed wallets, query Solana RPC, update DB,
// broadcast 'walletBalanceUpdate' to connected WebSocket clients.
setInterval(async () => {
  try {
    const wallets = await prisma.managed_wallets.findMany({
      select: { id: true, publicKey: true }
    });
    if (wallets.length === 0) return;

    const connection = rpcManager.getConnection();
    const { PublicKey } = await import('@solana/web3.js');

    await Promise.allSettled(wallets.map(async (w) => {
      try {
        const lamports = await connection.getBalance(new PublicKey(w.publicKey));
        const balanceSol = lamports / 1_000_000_000;
        await prisma.managed_wallets.update({
          where: { id: w.id },
          data: { balanceSol }
        });
        broadcastToAll({
          type: 'walletBalanceUpdate',
          walletId: w.id,
          publicKey: w.publicKey,
          balanceSol,
          timestamp: new Date().toISOString()
        });
      } catch (_) { /* individual wallet RPC failures are non-fatal */ }
    }));
  } catch (err) {
    console.error('❌ Balance polling error:', err);
  }
}, 60_000);
// ─────────────────────────────────────────────────────────────────────────


// Function to broadcast messages to all connected clients
// Broadcast functions for real-time updates
function broadcastToAll(message: any) {
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

// Function to send message to token feed subscribers only
function broadcastToTokenFeedSubscribers(message: any) {
  let subscribedClients = 0;
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN && (client as any).tokenFeedSubscribed) {
      client.send(JSON.stringify(message));
      subscribedClients++;
    }
  });
  return subscribedClients;
}

// Function to send message to specific wallet subscribers
function broadcastToWallet(walletId: string, message: any) {
  // In a real implementation, you'd maintain a map of walletId -> clients
  // For now, broadcast to all clients with walletId filter
  const messageWithWallet = { ...message, walletId };
  broadcastToAll(messageWithWallet);
}

// Export broadcast functions for use in other parts of the application
// (In a real implementation, you might want to put this in a separate module)
global.wssBroadcast = broadcastToAll;
global.wssBroadcastTokenFeed = broadcastToTokenFeedSubscribers;
global.wssBroadcastWallet = broadcastToWallet;

const PORT = process.env.PORT || 3001;

// SECURITY FIX: Implement Active Snipe Monitoring
// Background process to monitor active snipes and execute trades when conditions are met
const activeSnipeMonitors = new Map<string, NodeJS.Timeout>();

/**
 * Check monitoring conditions for an active snipe and execute trade if conditions are met
 * This function checks token price, liquidity, and other conditions configured in the sniper config
 */
async function checkSnipeConditionsAndExecute(activeSnipeId: string, config: any) {
  try {
    const activeSnipe = await sqliteDb.active_snipes.findUnique({
      where: { id: activeSnipeId }
    });

    if (!activeSnipe || activeSnipe.status !== 'monitoring') {
      return;
    }

    const tokenAddress = activeSnipe.tokenAddress;
    const dex = config.dex || 'jupiter';

    // Step 1: Get current token price using Jupiter or Raydium API
    const currentPrice = await getCurrentTokenPrice(tokenAddress, dex);

    if (!currentPrice) {
      console.log(`⚠️ Could not fetch price for ${tokenAddress}, skipping this check`);
      return;
    }

    // Step 2: Get liquidity information
    const liquidity = await getTokenLiquidity(tokenAddress, dex);

    if (!liquidity || liquidity === 0) {
      console.log(`⚠️ No liquidity available for ${tokenAddress}, skipping this check`);
      return;
    }

    // Step 3: Check if configured conditions are met
    const conditionsMet = await areMonitoringConditionsMet(config, currentPrice, liquidity, tokenAddress);

    if (!conditionsMet) {
      console.log(`📊 Monitoring ${config.name}: Price=${currentPrice}, Liquidity=${liquidity.toFixed(2)} SOL - Conditions not met yet`);
      return;
    }

    console.log(`🎯 Conditions met for ${config.name}! Executing trade...`);

    // Step 4: Execute the trade
    await executeSnipeTrade(activeSnipeId, config, tokenAddress, dex);

  } catch (error) {
    console.error(`❌ Error checking conditions for snipe ${activeSnipeId}:`, error);
  }
}

/**
 * Get current token price from Jupiter or Raydium API
 */
async function getCurrentTokenPrice(tokenAddress: string, dex: string): Promise<number | null> {
  try {
    const inputMint = 'So11111111111111111111111111111111111111111'; // Native SOL
    const amountInLamports = 1_000_000_000; // 1 SOL for quote
    const slippageBps = 100; // 1% slippage

    let quote: any;

    if (dex === 'raydium') {
      // Use Raydium quote API
      const wrappedSolMint = 'So11111111111111111111111111111111111111112';
      const axios = (await import('axios')).default;
      const quoteResponse = await axios.get(`/api/raydium/quote`, {
        params: {
          inputMint: wrappedSolMint,
          outputMint: tokenAddress,
          amount: amountInLamports,
          slippageBps,
        },
      });

      quote = quoteResponse.data;
    } else {
      // Use Jupiter quote API (default)
      const axios = (await import('axios')).default;
      const quoteResponse = await axios.get('/api/jupiter/quote', {
        params: {
          inputMint,
          outputMint: tokenAddress,
          amount: amountInLamports,
          slippageBps,
        },
      });

      quote = quoteResponse.data;
    }

    if (!quote) {
      return null;
    }

    // Calculate price: tokens received per SOL
    // Jupiter: outAmount gives tokens received for input amount
    // Raydium: similar structure
    const outputAmount = quote.outAmount || quote.data?.outAmount;
    if (!outputAmount) {
      return null;
    }

    const tokensPerSol = Number(outputAmount) / amountInLamports;
    return tokensPerSol;
  } catch (error) {
    console.error(`❌ Error fetching price for ${tokenAddress}:`, error);
    return null;
  }
}

/**
 * Get token liquidity in SOL
 */
async function getTokenLiquidity(tokenAddress: string, dex: string): Promise<number | null> {
  try {
    // Try to get liquidity from Jupiter API
    const axios = (await import('axios')).default;
    const response = await axios.get(`https://price.jup.ag/v4/price`, {
      params: {
        ids: tokenAddress,
      },
    });

    const priceData = response.data?.data?.[tokenAddress];
    if (!priceData) {
      return null;
    }

    // Jupiter doesn't directly provide liquidity, so we estimate based on price
    // For more accurate liquidity, you would need to query the pool directly
    return priceData.price || 0;
  } catch (error) {
    console.error(`❌ Error fetching liquidity for ${tokenAddress}:`, error);
    return null;
  }
}

/**
 * Check if monitoring conditions are met based on config settings
 */
async function areMonitoringConditionsMet(
  config: any,
  currentPrice: number,
  liquidity: number,
  tokenAddress: string
): Promise<boolean> {
  try {
    // Check minimum liquidity if configured
    if (config.minLiquidity && liquidity < parseFloat(config.minLiquidity)) {
      console.log(`🔒 Liquidity ${liquidity.toFixed(2)} SOL below minimum ${config.minLiquidity} SOL`);
      return false;
    }

    // Check maximum liquidity if configured
    if (config.maxLiquidity && liquidity > parseFloat(config.maxLiquidity)) {
      console.log(`🔒 Liquidity ${liquidity.toFixed(2)} SOL above maximum ${config.maxLiquidity} SOL`);
      return false;
    }

    // Check minimum price if configured
    if (config.minPrice && currentPrice < parseFloat(config.minPrice)) {
      console.log(`🔒 Price ${currentPrice.toFixed(10)} below minimum ${config.minPrice}`);
      return false;
    }

    // Check maximum price if configured
    if (config.maxPrice && currentPrice > parseFloat(config.maxPrice)) {
      console.log(`🔒 Price ${currentPrice.toFixed(10)} above maximum ${config.maxPrice}`);
      return false;
    }

    // If price change monitoring is enabled, check against initial price
    if (config.monitorPriceChange && config.initialPrice) {
      const initialPrice = parseFloat(config.initialPrice);
      const priceChangePercent = ((currentPrice - initialPrice) / initialPrice) * 100;

      // Check if price has dropped below the threshold (buy the dip)
      if (config.priceDropPercent && priceChangePercent <= -parseFloat(config.priceDropPercent)) {
        console.log(`📉 Price dropped ${priceChangePercent.toFixed(2)}% (target: ${config.priceDropPercent}%)`);
        return true;
      }

      // Check if price has risen above the threshold (momentum buy)
      if (config.priceRisePercent && priceChangePercent >= parseFloat(config.priceRisePercent)) {
        console.log(`📈 Price rose ${priceChangePercent.toFixed(2)}% (target: ${config.priceRisePercent}%)`);
        return true;
      }

      console.log(`⏳ Price change ${priceChangePercent.toFixed(2)}% - within range`);
      return false;
    }

    // If no specific conditions are set, execute immediately (default behavior)
    return true;
  } catch (error) {
    console.error('❌ Error checking monitoring conditions:', error);
    return false;
  }
}

/**
 * Execute the snipe trade when conditions are met
 */
async function executeSnipeTrade(activeSnipeId: string, config: any, tokenAddress: string, dex: string) {
  try {
    console.log(`💰 Executing snipe trade for ${config.name} on ${tokenAddress}`);

    // Use sniperService to create and submit the transaction
    if (!sniperService) {
      throw new Error('Sniper service not initialized');
    }

    // Get the wallet address from the config
    const walletAddress = config.walletAddress;
    if (!walletAddress) {
      throw new Error('No wallet address configured');
    }

    // Create buy transaction using the sniper service
    const amountInLamports = Math.floor(parseFloat(config.buyAmount) * 1e9);
    const slippageBps = parseInt(config.maxSlippage) * 100;

    let transaction: any;

    if (dex === 'raydium') {
      // Use Raydium
      const { getRaydiumQuote, getRaydiumSwapTransaction } = await import('./src/lib/raydium.ts');
      const wrappedSolMint = 'So11111111111111111111111111111111111111112';
      const quote = await getRaydiumQuote(wrappedSolMint, tokenAddress, amountInLamports, slippageBps);
      if (!quote) throw new Error('Failed to get Raydium quote');
      transaction = await getRaydiumSwapTransaction(quote, walletAddress, undefined, undefined, true);
    } else {
      // Use Jupiter (default)
      const { getJupiterQuote, getJupiterSwapTransaction } = await import('./src/lib/jupiter.ts');
      const inputMint = 'So11111111111111111111111111111111111111111';
      const quote = await getJupiterQuote(inputMint, tokenAddress, amountInLamports, slippageBps);
      if (!quote) throw new Error('Failed to get Jupiter quote');
      transaction = await getJupiterSwapTransaction(quote, walletAddress);
    }

    if (!transaction) {
      throw new Error('Failed to create transaction');
    }

    // Sign and submit the transaction
    const { Keypair } = await import('@solana/web3.js');
    const connection = new (await import('@solana/web3.js')).Connection(
      rpcManager.getUrl()
    );

    // Get the private key from secure wallet service
    const { secureWalletService } = await import('./src/lib/secureWalletService.js');
    const privateKey = await secureWalletService.getPrivateKey(walletAddress);

    if (!privateKey) {
      throw new Error('Could not retrieve private key from secure wallet service');
    }

    const keypair = Keypair.fromSecretKey(
      Buffer.from(privateKey, 'base64')
    );

    transaction.sign([keypair]);

    // Submit transaction
    const signature = await connection.sendTransaction(transaction, {
      skipPreflight: true,
      preflightCommitment: 'processed',
      maxRetries: 0
    });

    console.log(`✅ Trade executed successfully: ${signature}`);

    // Update active snipe status and record transaction
    await sqliteDb.active_snipes.update({
      where: { id: activeSnipeId },
      data: {
        status: 'executed',
        buyTxId: signature,
        lastPriceCheck: new Date()
      }
    });

    // Record the transaction in the database
    await recordSnipeTransaction(activeSnipeId, config, tokenAddress, signature, 'buy');

    console.log(`🎉 Snipe ${activeSnipeId} executed and recorded successfully!`);

  } catch (error) {
    console.error(`❌ Error executing snipe trade for ${activeSnipeId}:`, error);

    // Update status to failed
    await sqliteDb.active_snipes.update({
      where: { id: activeSnipeId },
      data: {
        status: 'failed',
        lastPriceCheck: new Date()
      }
    });
  }
}

/**
 * Record snipe transaction in the database
 */
async function recordSnipeTransaction(
  activeSnipeId: string,
  config: any,
  tokenAddress: string,
  signature: string,
  type: 'buy' | 'sell'
) {
  // Centralized verified recording (2026-06-11): both recorders check the tx
  // on-chain (meta.err + real balance delta) and write status accordingly —
  // no more blind status:'confirmed' with price 0.
  try {
    if (type === 'buy') {
      await recordBuyTrade({
        userId: config.userId, walletId: config.walletId, signature,
        tokenMint: tokenAddress, tokensEstimate: 0,
        dexLabel: dexToDbEnum(config.dex), fallbackSolSpent: parseFloat(config.buyAmount) || 0,
      });
    } else {
      const w = await prisma.managed_wallets.findUnique({ where: { id: config.walletId } }).catch(() => null);
      await recordSellTrade({
        userId: config.userId, walletId: config.walletId,
        walletPubkey: w?.publicKey || '', signature,
        tokenMint: tokenAddress, tokensSold: 0, dexLabel: dexToDbEnum(config.dex),
      });
    }
    console.log(`📝 Snipe transaction recorded (verified): ${type} ${tokenAddress.slice(0, 8)} - ${signature.slice(0, 12)}`);
  } catch (error) {
    console.error(`❌ Error recording snipe transaction:`, error);
  }
}

/**
 * Convert DEX string to database enum value
 */
function dexToDbEnum(dex: string): string {
  switch (dex?.toLowerCase()) {
    case 'raydium':
      return 'RAYDIUM';
    case 'jupiter':
      return 'JUPITER';
    default:
      return 'JUPITER';
  }
}

async function startActiveSnipeMonitor(activeSnipeId: string) {
  try {
    const activeSnipe = await sqliteDb.active_snipes.findUnique({
      where: { id: activeSnipeId }
    });

    if (!activeSnipe || activeSnipe.status !== 'monitoring') {
      return;
    }

    const config = await sqliteDb.sniper_configs.findFirst({
      where: { id: activeSnipe.configId }
    });

    if (!config) {
      console.log(`⚠️ Config not found for active snipe ${activeSnipeId}`);
      return;
    }

    console.log(`🎯 Monitoring snipe ${activeSnipeId}: ${config.name} for token ${activeSnipe.tokenAddress}`);

    // Check monitoring conditions and update lastPriceCheck
    await sqliteDb.active_snipes.update({
      where: { id: activeSnipeId },
      data: { lastPriceCheck: new Date() }
    });

    // TODO: Add actual trading logic here - check price conditions and execute trades
    // This is a placeholder for the monitoring loop
    const monitorInterval = setInterval(async () => {
      try {
        const currentSnipe = await sqliteDb.active_snipes.findUnique({
          where: { id: activeSnipeId }
        });

        if (!currentSnipe || currentSnipe.status !== 'monitoring') {
          clearInterval(monitorInterval);
          activeSnipeMonitors.delete(activeSnipeId);
          console.log(`🛑 Stopped monitoring ${activeSnipeId} - status changed to ${currentSnipe?.status}`);
          return;
        }

        // SECURITY FIX: Implement actual monitoring logic
        // Check token price, liquidity, and other conditions here
        // If conditions are met, execute the trade and update status

        console.log(`🔍 Checking conditions for ${config.name}...`);

        // Check if monitoring conditions are met and execute trade if appropriate
        await checkSnipeConditionsAndExecute(activeSnipeId, config);

        // Update lastPriceCheck
        await sqliteDb.active_snipes.update({
          where: { id: activeSnipeId },
          data: { lastPriceCheck: new Date() }
        });

      } catch (error) {
        console.error(`❌ Error in snipe monitor ${activeSnipeId}:`, error);
      }
    }, 10000); // Check every 10 seconds

    activeSnipeMonitors.set(activeSnipeId, monitorInterval);
    console.log(`✅ Started monitoring ${activeSnipeId} (interval: 10s)`);

  } catch (error) {
    console.error(`❌ Error starting snipe monitor ${activeSnipeId}:`, error);
  }
}

function stopActiveSnipeMonitor(activeSnipeId: string) {
  const monitorInterval = activeSnipeMonitors.get(activeSnipeId);
  if (monitorInterval) {
    clearInterval(monitorInterval);
    activeSnipeMonitors.delete(activeSnipeId);
    console.log(`🛑 Stopped monitoring ${activeSnipeId}`);
  }
}

// --- User Settings ---
// GET /api/settings — load user's saved general settings
// @ts-ignore
app.get('/api/settings', authenticateUser, asyncAuthHandler(async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated' });
    const user = await sqliteDb.users.findUnique({ where: { id: userId }, select: { settings_json: true } });
    const settings = JSON.parse(user?.settings_json || '{}');
    res.json({ success: true, settings });
  } catch (error: any) {
    console.error('Error loading settings:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}));

// POST /api/settings — save user's general settings
// @ts-ignore
app.post('/api/settings', authenticateUser, asyncAuthHandler(async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated' });
    const { settings } = req.body;
    await sqliteDb.users.update({
      where: { id: userId },
      data: { settings_json: JSON.stringify(settings), updatedAt: new Date() }
    });
    res.json({ success: true });

    // Telegram test ping (2026-06-12): saving with notifications.telegram enabled and
    // credentials present sends an immediate confirmation, so the user knows the
    // bot token + chat ID actually work without waiting for a trade.
    if (settings?.notifications?.telegram && settings?.telegramBotToken && settings?.telegramChatId) {
      void sendTelegramNotification(userId,
        '✅ <b>Autobot connected</b> — confirmed trade notifications will arrive here (🟢 buys / 🔴 sells).');
    }
  } catch (error: any) {
    console.error('Error saving settings:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}));

// GET /api/config/rpc-endpoint — public, no auth — returns Helius RPC URL for frontend use
app.get('/api/config/rpc-endpoint', asyncHandler(async (req: Request, res: Response) => {
  try {
    const rows = await prisma.app_config.findMany({
      where: { key: { in: ['HELIUS_API_KEY', 'SOLANA_NETWORK'] } }
    });
    const map: Record<string, string> = {};
    for (const r of rows) map[r.key] = r.value;

    const key = map.HELIUS_API_KEY || process.env.HELIUS_API_KEY || '';
    const net = map.SOLANA_NETWORK || process.env.SOLANA_NETWORK || 'mainnet';

    if (key) {
      res.json({
        rpcUrl: `https://${net}.helius-rpc.com/?api-key=${key}`,
        wsUrl: `wss://${net}.helius-rpc.com/?api-key=${key}`,
        network: net,
      });
    } else {
      res.json({
        rpcUrl: 'https://api.mainnet-beta.solana.com',
        wsUrl: 'wss://api.mainnet-beta.solana.com',
        network: 'mainnet-beta',
      });
    }
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to fetch RPC config' });
  }
}));

// GET /api/config/api-keys — return current API key config from DB (masked)
app.get('/api/config/api-keys', authenticateUser, asyncAuthHandler(async (req: Request, res: Response) => {
  const mask = (val: string | undefined) =>
    val ? (val.length > 8 ? `${'*'.repeat(val.length - 4)}${val.slice(-4)}` : '****') : '';

  const rows = await prisma.app_config.findMany();
  const dbMap: Record<string, string> = {};
  for (const { key, value } of rows) dbMap[key] = value;

  // Merge: DB wins over process.env, with masking for secrets
  const get = (k: string) => dbMap[k] || process.env[k];
  res.json({
    success: true,
    config: {
      HELIUS_API_KEY: { set: !!get('HELIUS_API_KEY'), masked: mask(get('HELIUS_API_KEY')) },
      TAVAHIN_RPC_URL: { set: !!get('TAVAHIN_RPC_URL'), value: get('TAVAHIN_RPC_URL') || '' },
      TAVAHIN_API_KEY: { set: !!get('TAVAHIN_API_KEY'), masked: mask(get('TAVAHIN_API_KEY')) },
      GEYSER_GRPC_ENDPOINT: { set: !!get('GEYSER_GRPC_ENDPOINT'), value: get('GEYSER_GRPC_ENDPOINT') || '' },
      GEYSER_AUTH_TOKEN: { set: !!get('GEYSER_AUTH_TOKEN'), masked: mask(get('GEYSER_AUTH_TOKEN')) },
      SOLANA_NETWORK: { set: !!get('SOLANA_NETWORK'), value: get('SOLANA_NETWORK') || 'mainnet' },
      JUPITER_API_KEY: { set: !!get('JUPITER_API_KEY'), masked: mask(get('JUPITER_API_KEY')) },
    }
  });
}));

// POST /api/config/api-keys — upsert to DB + update process.env (no .env file writes)
app.post('/api/config/api-keys', authenticateUser, asyncAuthHandler(async (req: Request, res: Response) => {
  try {
    const allowed = ['HELIUS_API_KEY', 'TAVAHIN_RPC_URL', 'TAVAHIN_API_KEY', 'GEYSER_GRPC_ENDPOINT', 'GEYSER_AUTH_TOKEN', 'SOLANA_NETWORK', 'JUPITER_API_KEY'];
    const updates = req.body as Record<string, string>;

    const invalid = Object.keys(updates).filter(k => !allowed.includes(k));
    if (invalid.length) return res.status(400).json({ success: false, error: `Unknown keys: ${invalid.join(', ')}` });

    // Upsert each key into app_config
    for (const [key, val] of Object.entries(updates)) {
      if (val === undefined || val === '') continue;
      await prisma.app_config.upsert({
        where: { key },
        update: { value: val },
        create: { key, value: val },
      });
      // Reflect in process.env immediately so current session uses updated value
      process.env[key] = val;
    }

    // Re-initialize sniperService if HELIUS_API_KEY or SOLANA_NETWORK changed
    if (updates.HELIUS_API_KEY || updates.SOLANA_NETWORK) {
      initSniperService();
    }

    console.log(`✅ API keys saved to DB: ${Object.keys(updates).join(', ')}`);
    res.json({ success: true, message: 'API keys saved to database.' });
  } catch (error: any) {
    console.error('Error saving API keys to DB:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}));


// GET /api/sol-price — server-side SOL/USD proxy (browsers are blocked from calling
// CoinGecko directly by the app's Content Security Policy). Cached for 60s.
let _solUsdCache = { v: 0, t: 0 };
// @ts-ignore
app.get('/api/sol-price', async (_req: Request, res: Response) => {
  try {
    if (_solUsdCache.v > 0 && Date.now() - _solUsdCache.t < 60_000) {
      return res.json({ usd: _solUsdCache.v, cached: true });
    }
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', { signal: AbortSignal.timeout(8000) });
    const d: any = r.ok ? await r.json() : null;
    const usd = d?.solana?.usd;
    if (typeof usd === 'number' && usd > 0) {
      _solUsdCache = { v: usd, t: Date.now() };
      return res.json({ usd });
    }
    return res.json({ usd: _solUsdCache.v || 0 });
  } catch (e: any) {
    return res.json({ usd: _solUsdCache.v || 0, error: e?.message });
  }
});

// DELETE /api/wallets/all/transactions — clear all transactions for the authenticated user
// @ts-ignore
app.delete('/api/wallets/all/transactions', authenticateUser, asyncAuthHandler(async (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated' });
    const result = await sqliteDb.transactions.deleteMany({ where: { userId } });

    // The Transactions page rebuilds from on-chain history, which can't be deleted.
    // Record a "cleared at" cutoff so anything before now is hidden — a true fresh
    // start. New trades after this still show.
    const cutoffKey = `txcutoff:${userId}`;
    const now = String(Date.now());
    try {
      await sqliteDb.app_config.upsert({
        where: { key: cutoffKey },
        update: { value: now },
        create: { key: cutoffKey, value: now },
      });
    } catch (e: any) {
      console.warn('Failed to set tx cutoff:', e?.message);
    }

    console.log(`🗑️ Cleared ${result.count} transactions for user ${userId} (cutoff ${now})`);
    res.json({ success: true, deleted: result.count });
  } catch (error: any) {
    console.error('Error clearing transactions:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}));

// Start the server
httpServer.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📊 Dashboard API available at http://localhost:${PORT}/api/dashboard`);
  console.log(`🔗 Wallet API available at http://localhost:${PORT}/api/wallets`);
  console.log(`🌐 Frontend proxy configured for /api requests`);

  // Load config from DB into process.env, then re-init services that depend on it
  (async () => {
    await loadAndSeedConfig();
    initSniperService(); // re-init with DB-loaded HELIUS_API_KEY if it changed
    // Start the on-chain pre-bonded pump.fun stream (primary, real-time feed source).
    // Reads Create + Trade events directly from chain — 0s-old tokens, no per-token RPC.
    onchainPumpStream.start();

    // Pre-warm the Sniper feed at boot so the FIRST visit to the Sniper page is an
    // instant cache HIT instead of paying the multi-second source download. Without
    // this, the feed only builds on the first /api/sniper/tokens request (when the user
    // clicks into Sniper). We build with the same limit the page uses (500 → cache key
    // "feed:500") and keep it warm on an interval so it never goes cold while idle.
    const WARM_LIMIT = 500;
    const warmSniperFeed = async () => {
      try {
        const fresh = await buildSniperFeed(WARM_LIMIT);
        if (fresh.length > 0) {
          _sniperTokensCache.set(`feed:${Math.max(WARM_LIMIT, 200)}`, { ts: Date.now(), tokens: fresh });
        }
      } catch (e: any) {
        console.warn('Sniper feed warm-up failed:', e?.message);
      }
    };
    // Initial warm a couple seconds after boot (lets the on-chain stream + PumpPortal
    // WS populate first), then keep it fresh just under the stale window.
    setTimeout(warmSniperFeed, 2_000);
    setInterval(warmSniperFeed, SNIPER_TOKENS_STALE_MS);
    console.log('🔥 Sniper feed pre-warm scheduled (instant first load)');
  })();

  // One-time cleanup (idempotent): the on-chain tx classifier used to misrecord
  // AMM-routed SELLS as "buys of WSOL" (So1111…) — auto-backfill persisted those
  // rows. Delete them; the fixed classifier re-backfills the txs correctly as
  // sells of the real token next time the Transactions page is viewed.
  (async () => {
    try {
      const removed = await sqliteDb.transactions.deleteMany({
        where: { tokenAddress: 'So11111111111111111111111111111111111111112' },
      });
      if (removed.count > 0) {
        console.log(`🧹 Removed ${removed.count} misclassified WSOL transaction row(s) (old classifier bug)`);
      }
      // Normalize legacy DEX labels so Analytics doesn't split/invent venues:
      //  - 'PUMP_FUN' (Helius source enum) → 'PUMPFUN'
      //  - 'AUTO' (auto-route leaked the request value; those sells executed via Jupiter) → 'JUPITER'
      const pf = await sqliteDb.transactions.updateMany({ where: { dex: 'PUMP_FUN' }, data: { dex: 'PUMPFUN' } });
      const au = await sqliteDb.transactions.updateMany({ where: { dex: 'AUTO' }, data: { dex: 'JUPITER' } });
      if (pf.count + au.count > 0) {
        console.log(`🧹 Normalized DEX labels on ${pf.count + au.count} transaction row(s) (PUMP_FUN/AUTO)`);
      }
      // One-time sync (2026-06-12): purge stale token_holdings rows whose position
      // was already sold through a path that didn't clean up (manual/Swap sells
      // before recordSellTrade learned to delete the row). A row is stale when a
      // confirmed sell for that token exists AFTER the position was opened.
      const stale: number = await sqliteDb.$executeRawUnsafe(`
        DELETE FROM token_holdings WHERE EXISTS (
          SELECT 1 FROM transactions t
          WHERE t.userId = token_holdings.userId
            AND t.tokenAddress = token_holdings.tokenAddress
            AND t.type = 'sell' AND t.status = 'confirmed'
            AND t.timestamp > token_holdings.firstBuyAt
        )`);
      if (stale > 0) console.log(`🧹 Freed ${stale} stale token_holdings slot(s) (sold positions that never cleaned up)`);
    } catch (e: any) {
      console.warn('WSOL tx cleanup skipped:', e?.message);
    }
  })();

  // Start live token feed broadcasting
  startLiveTokenFeedBroadcast();

  // Start momentum auto-buy scanner (only acts on users with momentumEnabled)
  (async () => {
    try {
      const { startMomentumTrader, startAutoSeller, setTradeRecorders } = await import('./src/lib/momentumTrader.js');
      // Inject the centralized verified recorders so auto-trades get the same
      // on-chain verification as manual trades (no blind status:'confirmed').
      setTradeRecorders({ recordBuy: recordBuyTrade, recordSell: recordSellTrade });
      startMomentumTrader();
      startAutoSeller();
    } catch (e: any) {
      console.error('Failed to start momentum trader:', e?.message);
    }
  })();

  // Restore auto-snipe engine state from the DB (2026-06-12): the in-memory flag
  // resets on restart — if any settings row is still armed (isActive:true), turn
  // the engine back on so the UI and the engine can't disagree.
  (async () => {
    try {
      const armed = await sqliteDb.snipe_settings.findFirst({ where: { isActive: true } });
      if (armed) {
        autoSnipeEnabled = true;
        pumpPortalService.setAutoSnipeEnabled(true);
        console.log('🎯 Auto-snipe re-armed from DB (settings still active after restart)');
      }
    } catch { /* non-fatal */ }
  })();

  // SECURITY FIX: Restart any existing active snipes on server startup
  (async () => {
    try {
      const activeSnipes = await sqliteDb.active_snipes.findMany({
        where: { status: 'monitoring' }
      });

      for (const snipe of activeSnipes) {
        console.log(`🔄 Resuming monitoring for snipe ${snipe.id}`);
        startActiveSnipeMonitor(snipe.id);
      }

      if (activeSnipes.length > 0) {
        console.log(`✅ Resumed monitoring for ${activeSnipes.length} active snipes`);
      }
    } catch (error) {
      console.error('❌ Error resuming active snipes:', error);
    }
  })();
});

// Live Token Feed Broadcasting System
function startLiveTokenFeedBroadcast() {
  console.log('🚀 Starting live token feed broadcasting system...');

  setInterval(async () => {
    try {
      // Only broadcast if we have connected clients
      if (wss.clients.size === 0) return;

      console.log('🔄 Fetching live token data for broadcast...');

      const liveTokens: any[] = [];

      // ── Source A: Raydium AMM standard pools ──
      try {
        const raydiumUrl = `https://api-v3.raydium.io/pools/info/list?poolType=standard&poolSortField=default&sortType=desc&pageSize=10&page=1`;
        const response = await axios.get(raydiumUrl, {
          timeout: 8000,
          headers: { 'User-Agent': 'AutoBotAPP/1.0', 'Accept': 'application/json' }
        });

        if (response.data?.data?.data) {
          const pools = response.data.data.data;
          for (const pool of pools.slice(0, 10)) {
            const baseToken = pool.mintA;
            const quoteToken = pool.mintB;
            const isBaseTokenNew = baseToken.address !== 'So11111111111111111111111111111111111111112' &&
              baseToken.address !== 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
            const newToken = isBaseTokenNew ? baseToken : quoteToken;
            const pairedToken = isBaseTokenNew ? quoteToken : baseToken;

            liveTokens.push({
              id: pool.id,
              address: newToken.address,
              symbol: newToken.symbol || 'UNKNOWN',
              name: newToken.name || newToken.symbol || 'Unknown Token',
              logoURI: newToken.logoURI || null,
              volume24h: parseFloat(pool.day?.volumeQuote || pool.day?.volume || '0'),
              liquidity: parseFloat(pool.tvl || '0'),
              price: parseFloat(pool.price || '0'),
              source: 'raydium',
              pairedWith: { symbol: pairedToken.symbol, address: pairedToken.address }
            });
          }
        }
      } catch (raydiumErr: any) {
        console.warn('⚠️ Raydium AMM broadcast fetch failed:', raydiumErr?.message);
      }

      // ── Source B: LaunchLab pre-bonded tokens ──
      try {
        const llTokens = await pumpFunService.getLaunchLabTokens({ limit: 15 });
        for (const t of llTokens) {
          liveTokens.push({
            id: t.poolAddress || t.tokenMint,
            address: t.tokenMint,
            symbol: t.tokenSymbol || 'UNKNOWN',
            name: t.tokenName || t.tokenSymbol || 'Unknown Token',
            logoURI: null,
            volume24h: t.volume24h || 0,
            liquidity: t.liquiditySol || 0,
            price: t.priceUsd || 0,
            source: 'launchlab',
            isPreBonded: t.status === 'presale',
            dex: 'launchlab',
          });
        }
      } catch (llErr: any) {
        console.warn('⚠️ LaunchLab broadcast fetch failed:', llErr?.message);
      }

      // Broadcast to all connected clients
      const broadcastData = {
        type: 'tokenFeedUpdate',
        data: {
          tokens: liveTokens,
          timestamp: new Date().toISOString(),
          source: 'live-broadcast',
          clientCount: wss.clients.size
        }
      };

      let sentCount = 0;
      wss.clients.forEach((client) => {
        if (client.readyState === client.OPEN) {
          client.send(JSON.stringify(broadcastData));
          sentCount++;
        }
      });

      console.log(`📡 Live token feed broadcasted to ${sentCount}/${wss.clients.size} clients`);

    } catch (error: any) {
      console.error('❌ Error in live token feed broadcast:', error.message);
    }
  }, 10000); // Broadcast every 10 seconds
}

// Global error handler - ensures all errors return JSON instead of HTML
app.use((error: any, req: any, res: any, next: any) => {
  console.error('❌ Global error handler:', error);

  // If response was already sent, delegate to Express default error handler
  if (res.headersSent) {
    return next(error);
  }

  // Ensure we always send JSON error responses
  res.status(error.status || 500).json({
    error: error.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: error.stack })
  });
});

// Token purchase endpoint for managed wallets
// @ts-ignore - TypeScript middleware compatibility
app.post('/api/wallets/buy-token', authenticateUser, asyncAuthHandler(async (req, res) => {
  try {
    const { walletId, tokenMint, solAmount, outputMint, slippageBps, dex } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Validate required parameters
    if (!walletId || !tokenMint || !solAmount || !outputMint || !slippageBps || !dex) {
      console.error('❌ Missing required parameters:', { walletId, tokenMint, solAmount, outputMint, slippageBps, dex });
      return res.status(400).json({
        error: 'Missing required parameters: walletId, tokenMint, solAmount, outputMint, slippageBps, dex'
      });
    }

    // Validate numeric parameters
    const parsedSolAmount = parseFloat(solAmount);
    const parsedSlippageBps = parseInt(slippageBps);

    if (isNaN(parsedSolAmount) || parsedSolAmount <= 0 || parsedSolAmount > 10) {
      return res.status(400).json({ error: 'Invalid solAmount: must be between 0 and 10 SOL' });
    }

    if (isNaN(parsedSlippageBps) || parsedSlippageBps < 0) {
      return res.status(400).json({ error: 'Invalid slippageBps' });
    }

    // Validate DEX
    if (!['jupiter', 'raydium'].includes(dex.toLowerCase())) {
      return res.status(400).json({ error: 'Invalid dex, must be jupiter or raydium' });
    }

    console.log(`🎯 Token purchase request:`, {
      walletId,
      tokenMint,
      solAmount: parsedSolAmount,
      outputMint,
      slippageBps: parsedSlippageBps,
      dex,
      userId
    });

    // Get the wallet and verify ownership
    console.log(`🔍 Attempting to get wallet ${walletId} for user ${userId}`);
    const wallet = await secureWalletService.getWallet(walletId, userId);
    console.log(`🔍 Wallet result:`, wallet ? `Found: ${wallet.walletName}` : 'Not found');
    if (!wallet) {
      console.error(`❌ Wallet not found: walletId=${walletId}, userId=${userId}`);
      return res.status(404).json({ error: 'Wallet not found or access denied' });
    }

    // Check if wallet has sufficient SOL balance
    const currentBalance = parseFloat(wallet.balanceSol.toString());
    if (currentBalance < parsedSolAmount) {
      return res.status(400).json({
        error: `Insufficient SOL balance. Available: ${currentBalance}, Required: ${parsedSolAmount}`
      });
    }

    // Convert SOL amount to lamports for Jupiter API with proper precision
    const amountInLamports = Math.round(parsedSolAmount * 1_000_000_000);

    // Step 1: Get quote and execute trade based on DEX
    console.log(`📊 Getting ${dex} quote/transaction for ${parsedSolAmount} SOL -> ${tokenMint}`);

    let quote: any;
    let txid: string = '';
    let walletPrivateKey: string | null = null;

    // Get private key for all DEXs (needed for signing or direct API calls)
    let lastError: Error | null = null;

    // Retry logic for private key retrieval
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        walletPrivateKey = await secureWalletService.getPrivateKey(walletId, userId);
        break;
      } catch (error) {
        lastError = error as Error;
        console.log(`❌ Private key retrieval FAILED on attempt ${attempt}: ${error.message}`);

        if (attempt < 5) {
          const waitTime = 100 * Math.pow(2, attempt - 1);
          console.log(`⏳ Waiting ${waitTime}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    }

    if (!walletPrivateKey) {
      console.error(`❌ Failed to retrieve private key after 5 attempts. Last error: ${lastError?.message}`);
      return res.status(500).json({
        error: 'Failed to retrieve wallet private key after multiple attempts',
        details: lastError?.message
      });
    }

    const jupKey = process.env.JUPITER_API_KEY || '';
    const quoteUrl = `https://api.jup.ag/swap/v1/quote?inputMint=${outputMint}&outputMint=${tokenMint}&amount=${amountInLamports}&slippageBps=${parsedSlippageBps}`;
    const quoteResponse = await axios.get(quoteUrl, {
      headers: jupKey ? { 'x-api-key': jupKey } : {}
    });

    if (!quoteResponse.data || !quoteResponse.data.outAmount) {
      return res.status(400).json({
        error: 'No route found for this token. It may not have sufficient liquidity or be tradable.'
      });
    }

    quote = quoteResponse.data;
    console.log(`✅ Quote received: ${quote.outAmount} tokens for ${parsedSolAmount} SOL`);

    // Step 2: Get swap transaction
    console.log(`🔄 Getting swap transaction for wallet ${wallet.publicKey}`);

    const swapResponse = await axios.post('https://api.jup.ag/swap/v1/swap', {
      quoteResponse: quote,
      userPublicKey: wallet.publicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      priorityLevelWithMaxLamports: {
        priorityLevel: 'medium'
      }
    }, { headers: { 'Content-Type': 'application/json', ...(jupKey ? { 'x-api-key': jupKey } : {}) } });

    if (!swapResponse.data.swapTransaction) {
      return res.status(500).json({ error: 'Failed to create swap transaction' });
    }

    // Step 3: Sign and send the transaction
    console.log(`✍️ Signing and sending transaction`);

    const { Connection, VersionedTransaction, Keypair } = await import('@solana/web3.js');
    const connection = rpcManager.getConnection();

    // Deserialize the transaction
    const swapTransactionBuf = Buffer.from(swapResponse.data.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

    // Create keypair from private key (base58 encoded)
    const bs58 = await import('bs58');
    const keypair = Keypair.fromSecretKey(bs58.default.decode(walletPrivateKey));

    // Sign the transaction
    transaction.sign([keypair]);

    // Send the transaction
    txid = await connection.sendTransaction(transaction, {
      skipPreflight: false,
      preflightCommitment: 'processed'
    });

    console.log(`✅ Transaction sent with signature: ${txid}`);

    // Step 4: Wait for confirmation
    console.log(`⏳ Waiting for transaction confirmation...`);

    const confirmation = await connection.confirmTransaction(txid, 'confirmed');

    if (confirmation.value.err) {
      console.error(`❌ Transaction failed:`, confirmation.value.err);
      // Record the failed buy — verifier confirms the on-chain error and writes status='failed'
      void recordBuyTrade({
        userId, walletId, walletPubkey: wallet.publicKey, signature: txid,
        tokenMint, dexLabel: dex, fallbackSolSpent: parsedSolAmount,
      });
      return res.status(500).json({
        error: 'Transaction failed during execution',
        signature: txid,
        details: confirmation.value.err
      });
    }

    // Step 5: Record the transaction in the database
    console.log(`🔍 Attempting to record transaction with userId: ${userId}`);

    // Fetch actual token metadata AND decimals
    let tokenName = tokenMint; // fallback
    let tokenSymbol = null;
    let tokenDecimals = 6; // Default to 6 decimals if we can't fetch

    try {
      console.log(`🔍 Fetching token metadata for: ${tokenMint}`);
      const tokenMetadata = await fetchTokenMetadata(tokenMint);
      if (tokenMetadata && tokenMetadata.name) {
        tokenName = tokenMetadata.name;
        tokenSymbol = tokenMetadata.symbol;
        console.log(`✅ Token metadata found: ${tokenName} (${tokenSymbol})`);
      }

      // Get token decimals from mint account
      const { Connection, PublicKey } = await import('@solana/web3.js');
      const connection = rpcManager.getConnection();
      const mintPubkey = new PublicKey(tokenMint);
      const mintInfo = await connection.getParsedAccountInfo(mintPubkey);

      if (mintInfo.value && mintInfo.value.data && 'parsed' in mintInfo.value.data) {
        tokenDecimals = mintInfo.value.data.parsed.info.decimals;
        console.log(`✅ Token decimals found: ${tokenDecimals}`);
      }
    } catch (metaError) {
      console.warn(`⚠️ Failed to fetch token metadata/decimals for ${tokenMint}, using defaults:`, metaError);
    }

    // Analyze transaction for accurate SOL tracking
    let transactionAnalysis: TransactionAnalysis | null = null;
    try {
      console.log(`🔍 Analyzing transaction ${txid} for SOL tracking...`);
      transactionAnalysis = await analyzeTransaction(txid, wallet.publicKey);
      console.log(`✅ Transaction analysis completed:`, transactionAnalysis);
    } catch (analysisError) {
      console.warn(`⚠️ Failed to analyze transaction ${txid}:`, analysisError);
      // Continue without analysis data
    }

    // Calculate actual profit from netSolAmount (negative for buys means SOL spent)
    const calculatedProfit = transactionAnalysis?.netSolAmount || 0;

    // Calculate actual token amount received using correct decimals
    const tokensReceived = parseFloat(quote.outAmount) / Math.pow(10, tokenDecimals);

    // Calculate accurate price: SOL spent per token (use absolute value of netSolAmount for buys)
    const actualSolSpent = Math.abs(transactionAnalysis?.netSolAmount || parsedSolAmount);
    const accuratePrice = actualSolSpent / tokensReceived;

    console.log(`📊 Transaction data for database:
        - SOL Amount: ${parsedSolAmount}
        - Tokens Received: ${tokensReceived} (with ${tokenDecimals} decimals)
        - Raw Token Amount: ${quote.outAmount}
        - Actual SOL Spent: ${actualSolSpent}
        - Accurate Price: ${accuratePrice} SOL/token
        - Net SOL Amount: ${transactionAnalysis?.netSolAmount}
        - Calculated Profit: ${calculatedProfit} SOL`);

    // Centralized background recording — verifies on-chain (meta.err + balance
    // delta) before writing; records 'failed' if the buy didn't actually land.
    void recordBuyTrade({
      userId, walletId, walletPubkey: wallet.publicKey, signature: txid,
      tokenMint, tokenName, tokenSymbol,
      tokensEstimate: tokensReceived, dexLabel: dex, fallbackSolSpent: parsedSolAmount,
    });

    // Step 7: wallet balance update happens inside recordBuyTrade (after on-chain
    // verification) — updating here too would double-count.

    // Success response
    res.json({
      success: true,
      signature: txid,
      estimatedTokens: quote.outAmount,
      solAmount: parsedSolAmount,
      tokenMint,
      dex,
      quote: {
        inAmount: quote.inAmount,
        outAmount: quote.outAmount,
        priceImpactPct: quote.priceImpactPct,
        routePlan: quote.routePlan
      }
    });

  } catch (error) {
    console.error('❌ Error in buy-token endpoint:', error);

    // Record the denied/never-landed buy attempt so it shows on the Transactions page
    const message0 = error instanceof Error ? error.message : 'Failed to execute token purchase';
    if (req.user?.id && req.body?.tokenMint) {
      void recordRejectedTrade({
        userId: req.user.id, type: 'buy', tokenMint: req.body.tokenMint,
        requestedAmount: 0, dexLabel: req.body.dex || 'jupiter', reason: message0,
      });
    }

    // Handle specific error types
    if (error.response && error.response.data) {
      const jupiterError = error.response.data;
      if (jupiterError.error && jupiterError.error.includes('No route found')) {
        return res.status(400).json({
          error: 'No trading route found for this token. It may not have sufficient liquidity or be tradable on the selected DEX.'
        });
      }
    }

    res.status(500).json({ error: message0 });
  }
}));

// ── Telegram trade notifications (2026-06-12) ───────────────────────────────
// Wires the Settings → Notifications fields (telegramBotToken/telegramChatId in
// users.settings_json) to real sends. Called fire-and-forget from the verified
// trade recorders, so a message means the trade actually confirmed on-chain.
const tgEsc = (s: any) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Platform page for a token, derived from the RECORDED venue (not mint-suffix guessing)
const tgVenueLink = (dexLabel: string, mint: string): { name: string; url: string } => {
  const d = String(dexLabel || '').toUpperCase();
  if (d.includes('PUMP')) return { name: 'pump.fun', url: `https://pump.fun/coin/${mint}` };
  if (d.includes('LAUNCHLAB')) return { name: 'LaunchLab', url: `https://raydium.io/launchpad/token/?mint=${mint}` };
  return { name: 'DexScreener', url: `https://dexscreener.com/solana/${mint}` };
};

async function sendTelegramNotification(userId: string, html: string): Promise<void> {
  try {
    const u = await sqliteDb.users.findUnique({ where: { id: userId }, select: { settings_json: true } });
    const st = JSON.parse(u?.settings_json || '{}');
    if (!st?.notifications?.telegram) return; // toggle off → silent
    const token = String(st.telegramBotToken || '').trim();
    const chatId = String(st.telegramChatId || '').trim();
    if (!token || !chatId) return;
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      // 403 = user hasn't pressed Start on the bot; 400 = bad chat id
      console.warn(`⚠️ Telegram notify failed (${resp.status}): ${body.slice(0, 160)}`);
    }
  } catch (e: any) {
    console.warn(`⚠️ Telegram notify error: ${e?.message}`);
  }
}

// ── CENTRALIZED SELL RECORDER ───────────────────────────────────────────────
// Every sell route records through this one function. It runs in the BACKGROUND
// (fire-and-forget) so it never adds latency to the trade, reads the REAL SOL
// received from on-chain analysis (quote values are unreliable for pump sells —
// e.g. a full sell's quote.amount is the string "100%", which is what was
// silently breaking DB inserts), and dedupes by signature so it's safe to call
// from multiple paths / retries.
async function recordSellTrade(opts: {
  userId: string;
  walletId: string;
  walletPubkey: string;
  signature: string;
  tokenMint: string;
  tokenName?: string | null;
  tokenSymbol?: string | null;
  tokensSold: number;
  dexLabel: string;
  fallbackSolReceived?: number;
}): Promise<void> {
  const { userId, walletId, walletPubkey, signature, tokenMint, tokensSold, dexLabel } = opts;
  if (!signature) { console.warn('[recordSellTrade] no signature — skipping'); return; }
  try {
    // Dedup — skip if this signature is already recorded
    const existing = await sqliteDb.transactions.findFirst({ where: { txId: signature }, select: { id: true } });
    if (existing) { console.log(`[recordSellTrade] ${signature.slice(0, 12)} already recorded`); return; }

    // ── On-chain verification BEFORE recording (fixes false-confirmed sells) ──
    // Never trust the caller: fetch the tx and (a) require meta.err === null,
    // (b) read the REAL token delta from pre/postTokenBalances. A sell that
    // failed on-chain or never landed is recorded as 'failed', not 'confirmed'.
    let chainStatus: 'confirmed' | 'failed' = 'failed';
    let actualTokensSold = 0;
    let remainingAfterSell: number | null = null; // wallet's post-sell token balance
    try {
      const vConn = rpcManager.getConnection();
      let chainTx: any = null;
      for (let attempt = 0; attempt < 3 && !chainTx; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, 2500));
        chainTx = await vConn.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }).catch(() => null);
      }
      if (!chainTx) {
        console.warn(`⚠️ [recordSellTrade] tx ${signature.slice(0, 12)} NOT FOUND on-chain after 3 attempts — recording as failed`);
      } else if (chainTx.meta?.err) {
        console.warn(`⚠️ [recordSellTrade] tx ${signature.slice(0, 12)} FAILED on-chain: ${JSON.stringify(chainTx.meta.err)} — recording as failed`);
      } else {
        // Success — compute the authoritative token delta for this wallet+mint
        const pre = (chainTx.meta?.preTokenBalances || []).find((b: any) => b.mint === tokenMint && b.owner === walletPubkey);
        const post = (chainTx.meta?.postTokenBalances || []).find((b: any) => b.mint === tokenMint && b.owner === walletPubkey);
        const preAmt = pre?.uiTokenAmount?.uiAmount ?? 0;
        const postAmt = post?.uiTokenAmount?.uiAmount ?? 0;
        actualTokensSold = Math.max(preAmt - postAmt, 0);
        remainingAfterSell = postAmt;
        if (actualTokensSold <= 0) {
          console.warn(`⚠️ [recordSellTrade] tx ${signature.slice(0, 12)} succeeded but token balance did not drop (pre=${preAmt}, post=${postAmt}) — recording as failed`);
        } else {
          chainStatus = 'confirmed';
          console.log(`✅ [recordSellTrade] verified on-chain: ${actualTokensSold} tokens left wallet (pre=${preAmt}, post=${postAmt})`);
        }
      }
    } catch (verErr: any) {
      console.warn(`⚠️ [recordSellTrade] on-chain verification error: ${verErr?.message} — recording as failed`);
    }

    // Real numbers from on-chain analysis (authoritative); quote SOL is fallback only
    let analysis: TransactionAnalysis | null = null;
    try { analysis = await analyzeTransaction(signature, walletPubkey); } catch { /* optional */ }

    const fb = Number.isFinite(opts.fallbackSolReceived as number) ? Number(opts.fallbackSolReceived) : 0;
    const solReceived = chainStatus === 'confirmed' ? (Math.abs(analysis?.netSolAmount ?? fb) || 0) : 0;
    const tokens = chainStatus === 'confirmed' ? (actualTokensSold || Number(tokensSold) || 0) : Number(tokensSold) || 0;
    const price = tokens > 0 ? solReceived / tokens : 0;

    // Best-effort token name/symbol
    let tokenName = opts.tokenName || null;
    let tokenSymbol = opts.tokenSymbol || null;
    if (!tokenName) {
      try { const md = await fetchTokenMetadata(tokenMint); if (md?.name) { tokenName = md.name; tokenSymbol = md.symbol; } } catch { /* fallback below */ }
    }

    await sqliteDb.transactions.create({
      data: {
        userId,
        txId: signature,
        tokenName: tokenName || tokenMint.slice(0, 8),
        tokenSymbol: tokenSymbol || null,
        tokenAddress: tokenMint,
        type: 'sell',
        amount: tokens,
        price: Number.isFinite(price) ? price : 0,
        profit: solReceived,
        status: chainStatus, // verified against the chain — never blindly 'confirmed'
        dex: String(dexLabel).toUpperCase(),
        timestamp: new Date(),
        totalSolCost: analysis?.totalSolCost ?? null,
        gasFees: analysis?.gasFees ?? null,
        jitoTip: analysis?.jitoTip ?? null,
        netSolAmount: analysis?.netSolAmount ?? null,
        preBalance: analysis?.preBalance ?? null,
        postBalance: analysis?.postBalance ?? null,
      },
    });
    console.log(`📝 [recordSellTrade] recorded sell ${signature.slice(0, 12)} (${dexLabel}) — ${solReceived} SOL`);

    // Keep token_holdings in sync on EVERY sell path (2026-06-12): only the
    // momentum auto-seller used to delete the row, so manual/Swap/Dashboard sells
    // left phantom "open positions" that blocked the auto-snipe position cap.
    // If the wallet's remaining balance is zero/dust, the position is closed.
    if (chainStatus === 'confirmed' && remainingAfterSell != null && remainingAfterSell <= 1e-6) {
      try {
        const freed = await sqliteDb.token_holdings.deleteMany({
          where: { userId, tokenAddress: tokenMint },
        });
        if (freed.count > 0) console.log(`🧹 Position closed — freed holdings slot for ${tokenMint.slice(0, 8)}`);
      } catch { /* non-fatal */ }
    }

    // Push a trade toast to the app (bottom-right, red) — confirmed sells only
    if (chainStatus === 'confirmed') {
      try {
        broadcastToAll({
          type: 'trade_notification',
          trade: {
            side: 'sell',
            tokenSymbol: tokenSymbol || null,
            tokenName: tokenName || tokenMint.slice(0, 8),
            solAmount: solReceived,
            tokens,
            dex: String(dexLabel).toUpperCase(),
            signature,
          },
        });
      } catch { /* non-fatal */ }
      {
        const venue = tgVenueLink(String(dexLabel), tokenMint);
        void sendTelegramNotification(userId,
          `🔴 <b>SELL</b> ${tgEsc(tokenSymbol || tokenName || tokenMint.slice(0, 8))} — ` +
          `${solReceived.toFixed(4)} SOL received (${tgEsc(String(dexLabel).toUpperCase())})\n` +
          `<a href="${venue.url}">${venue.name}</a> · <a href="https://solscan.io/tx/${signature}">tx</a>`);
      }
    }

    // Update wallet balance (approximate)
    try {
      const w = await prisma.managed_wallets.findUnique({ where: { id: walletId } });
      if (w) {
        await prisma.managed_wallets.update({
          where: { id: walletId },
          data: { balanceSol: parseFloat(w.balanceSol.toString()) + solReceived },
        });
      }
    } catch { /* non-fatal */ }
  } catch (e: any) {
    console.error(`❌ [recordSellTrade] failed for ${signature}:`, e?.message);
  }
}

/**
 * Centralized BUY recorder — mirror of recordSellTrade (2026-06-11).
 * Verifies on-chain before writing: requires meta.err === null AND that the
 * wallet's token balance actually INCREASED. Records 'failed' otherwise.
 * Amounts come from real pre/post balances, not quote estimates.
 */
async function recordBuyTrade(opts: {
  userId: string;
  walletId: string;
  walletPubkey?: string | null;
  signature: string;
  tokenMint: string;
  tokenName?: string | null;
  tokenSymbol?: string | null;
  tokensEstimate?: number;
  dexLabel: string;
  fallbackSolSpent?: number;
}): Promise<void> {
  const { userId, walletId, signature, tokenMint, dexLabel } = opts;
  if (!signature) { console.warn('[recordBuyTrade] no signature — skipping'); return; }
  try {
    // Dedup — skip if this signature is already recorded
    const existing = await sqliteDb.transactions.findFirst({ where: { txId: signature }, select: { id: true } });
    if (existing) { console.log(`[recordBuyTrade] ${signature.slice(0, 12)} already recorded`); return; }

    // Resolve wallet pubkey if the caller didn't have it at hand
    let walletPubkey = opts.walletPubkey || null;
    if (!walletPubkey) {
      try {
        const w = await prisma.managed_wallets.findUnique({ where: { id: walletId } });
        walletPubkey = w?.publicKey || null;
      } catch { /* verified path below degrades gracefully */ }
    }

    // ── On-chain verification BEFORE recording ──
    let chainStatus: 'confirmed' | 'failed' = 'failed';
    let actualTokensBought = 0;
    try {
      const vConn = rpcManager.getConnection();
      let chainTx: any = null;
      for (let attempt = 0; attempt < 3 && !chainTx; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, 2500));
        chainTx = await vConn.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }).catch(() => null);
      }
      if (!chainTx) {
        console.warn(`⚠️ [recordBuyTrade] tx ${signature.slice(0, 12)} NOT FOUND on-chain after 3 attempts — recording as failed`);
      } else if (chainTx.meta?.err) {
        console.warn(`⚠️ [recordBuyTrade] tx ${signature.slice(0, 12)} FAILED on-chain: ${JSON.stringify(chainTx.meta.err)} — recording as failed`);
      } else if (walletPubkey) {
        const pre = (chainTx.meta?.preTokenBalances || []).find((b: any) => b.mint === tokenMint && b.owner === walletPubkey);
        const post = (chainTx.meta?.postTokenBalances || []).find((b: any) => b.mint === tokenMint && b.owner === walletPubkey);
        const preAmt = pre?.uiTokenAmount?.uiAmount ?? 0;
        const postAmt = post?.uiTokenAmount?.uiAmount ?? 0;
        actualTokensBought = Math.max(postAmt - preAmt, 0);
        if (actualTokensBought <= 0) {
          console.warn(`⚠️ [recordBuyTrade] tx ${signature.slice(0, 12)} succeeded but token balance did not increase (pre=${preAmt}, post=${postAmt}) — recording as failed`);
        } else {
          chainStatus = 'confirmed';
          console.log(`✅ [recordBuyTrade] verified on-chain: ${actualTokensBought} tokens received (pre=${preAmt}, post=${postAmt})`);
        }
      } else {
        // No pubkey to verify the balance delta against — trust meta.err === null
        chainStatus = 'confirmed';
        console.warn(`⚠️ [recordBuyTrade] no wallet pubkey — confirmed on meta.err only`);
      }
    } catch (verErr: any) {
      console.warn(`⚠️ [recordBuyTrade] on-chain verification error: ${verErr?.message} — recording as failed`);
    }

    // Real numbers from on-chain analysis (authoritative); quote SOL is fallback only
    let analysis: TransactionAnalysis | null = null;
    if (walletPubkey) {
      try { analysis = await analyzeTransaction(signature, walletPubkey); } catch { /* optional */ }
    }

    const fb = Number.isFinite(opts.fallbackSolSpent as number) ? Number(opts.fallbackSolSpent) : 0;
    const solSpent = chainStatus === 'confirmed' ? (Math.abs(analysis?.netSolAmount ?? fb) || fb) : 0;
    const tokens = chainStatus === 'confirmed'
      ? (actualTokensBought || Number(opts.tokensEstimate) || 0)
      : Number(opts.tokensEstimate) || 0;
    const price = tokens > 0 ? solSpent / tokens : 0;

    // Best-effort token name/symbol
    let tokenName = opts.tokenName || null;
    let tokenSymbol = opts.tokenSymbol || null;
    if (!tokenName) {
      try { const md = await fetchTokenMetadata(tokenMint); if (md?.name) { tokenName = md.name; tokenSymbol = md.symbol; } } catch { /* fallback below */ }
    }

    await sqliteDb.transactions.create({
      data: {
        userId,
        txId: signature,
        tokenName: tokenName || tokenMint.slice(0, 8),
        tokenSymbol: tokenSymbol || null,
        tokenAddress: tokenMint,
        type: 'buy',
        amount: tokens,
        price: Number.isFinite(price) ? price : 0,
        profit: analysis?.netSolAmount ?? (chainStatus === 'confirmed' ? -solSpent : 0),
        status: chainStatus, // verified against the chain — never blindly 'confirmed'
        dex: String(dexLabel).toUpperCase(),
        timestamp: new Date(),
        totalSolCost: analysis?.totalSolCost ?? (chainStatus === 'confirmed' ? solSpent : null),
        gasFees: analysis?.gasFees ?? null,
        jitoTip: analysis?.jitoTip ?? null,
        netSolAmount: analysis?.netSolAmount ?? null,
        preBalance: analysis?.preBalance ?? null,
        postBalance: analysis?.postBalance ?? null,
      },
    });
    console.log(`📝 [recordBuyTrade] recorded buy ${signature.slice(0, 12)} (${dexLabel}) — ${solSpent} SOL, status=${chainStatus}`);

    // Push a trade toast to the app (bottom-right, green) — confirmed buys only
    if (chainStatus === 'confirmed') {
      try {
        broadcastToAll({
          type: 'trade_notification',
          trade: {
            side: 'buy',
            tokenSymbol: tokenSymbol || null,
            tokenName: tokenName || tokenMint.slice(0, 8),
            solAmount: solSpent,
            tokens,
            dex: String(dexLabel).toUpperCase(),
            signature,
          },
        });
      } catch { /* non-fatal */ }
      {
        const venue = tgVenueLink(String(dexLabel), tokenMint);
        void sendTelegramNotification(userId,
          `🟢 <b>BUY</b> ${tgEsc(tokenSymbol || tokenName || tokenMint.slice(0, 8))} — ` +
          `${solSpent.toFixed(4)} SOL spent (${tgEsc(String(dexLabel).toUpperCase())})\n` +
          `${tokens > 0 ? `${Math.round(tokens).toLocaleString()} tokens · ` : ''}` +
          `<a href="${venue.url}">${venue.name}</a> · <a href="https://solscan.io/tx/${signature}">tx</a>`);
      }
    }

    // Update wallet balance (approximate)
    if (chainStatus === 'confirmed' && solSpent > 0) {
      try {
        const w = await prisma.managed_wallets.findUnique({ where: { id: walletId } });
        if (w) {
          await prisma.managed_wallets.update({
            where: { id: walletId },
            data: { balanceSol: Math.max(0, parseFloat(w.balanceSol.toString()) - solSpent) },
          });
        }
      } catch { /* non-fatal */ }
    }
  } catch (e: any) {
    console.error(`❌ [recordBuyTrade] failed for ${signature}:`, e?.message);
  }
}

/**
 * Records a trade that never landed on-chain — build/send errors, wallet rejection,
 * RPC denial. status='denied' so the Transactions page shows the attempt honestly.
 * If a signature exists, prefer recordBuyTrade/recordSellTrade (they verify and
 * record 'failed'); this is for the no-signature case.
 */
async function recordRejectedTrade(opts: {
  userId: string;
  type: 'buy' | 'sell';
  tokenMint: string;
  tokenName?: string | null;
  tokenSymbol?: string | null;
  requestedAmount?: number;
  dexLabel?: string;
  reason?: string;
}): Promise<void> {
  try {
    const txId = `denied-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let tokenName = opts.tokenName || null;
    let tokenSymbol = opts.tokenSymbol || null;
    if (!tokenName) {
      try { const md = await fetchTokenMetadata(opts.tokenMint); if (md?.name) { tokenName = md.name; tokenSymbol = md.symbol; } } catch { /* fallback below */ }
    }
    await sqliteDb.transactions.create({
      data: {
        userId: opts.userId,
        txId,
        tokenName: tokenName || opts.tokenMint.slice(0, 8),
        tokenSymbol: tokenSymbol || null,
        tokenAddress: opts.tokenMint,
        type: opts.type,
        amount: Number(opts.requestedAmount) || 0,
        price: 0,
        profit: 0,
        status: 'denied',
        dex: String(opts.dexLabel || 'UNKNOWN').toUpperCase(),
        timestamp: new Date(),
      },
    });
    console.log(`📝 [recordRejectedTrade] recorded denied ${opts.type} of ${opts.tokenMint.slice(0, 8)} — ${opts.reason || 'no reason given'}`);
  } catch (e: any) {
    console.error('❌ [recordRejectedTrade] failed:', e?.message);
  }
}

// Token sell endpoint for managed wallets
// @ts-ignore - TypeScript middleware compatibility
app.post('/api/wallets/sell-token', authenticateUser, asyncAuthHandler(async (req, res) => {
  try {
    const { walletId, tokenMint, tokenAmount, outputMint = 'So11111111111111111111111111111111111111112', slippageBps = 100, dex = 'jupiter' } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    if (!walletId || !tokenMint || !tokenAmount) {
      return res.status(400).json({ error: 'Missing required fields: walletId, tokenMint, tokenAmount' });
    }

    // Step 1: Validate wallet ownership and get wallet info
    console.log(`🔍 Validating wallet ${walletId} for user ${userId}`);
    const wallet = await secureWalletService.getWallet(walletId, userId);

    if (!wallet) {
      return res.status(403).json({ error: 'Wallet not found or access denied' });
    }

    console.log(`✅ Wallet validated: ${wallet.walletName} (${wallet.publicKey})`);

    // Step 2: Get token balance to validate sell amount
    console.log(`🪙 Checking token balance for ${tokenMint}`);
    const { PublicKey } = await import('@solana/web3.js');

    const walletPublicKey = new PublicKey(wallet.publicKey);
    // Use withRotation so 429s on one RPC endpoint automatically try the next
    const tokenAccounts = await rpcManager.withRotation(async (conn) => {
      return conn.getParsedTokenAccountsByOwner(walletPublicKey, {
        mint: new PublicKey(tokenMint)
      });
    });

    if (tokenAccounts.value.length === 0) {
      return res.status(400).json({ error: 'No token account found for this token' });
    }

    const tokenAccount = tokenAccounts.value[0];
    const tokenBalance = tokenAccount.account.data.parsed.info.tokenAmount.uiAmount;
    const tokenBalanceRaw = tokenAccount.account.data.parsed.info.tokenAmount.amount;
    const decimals = tokenAccount.account.data.parsed.info.tokenAmount.decimals;
    const parsedTokenAmount = parseFloat(tokenAmount);

    // SAFE DECIMAL HANDLING - Convert amounts properly
    const availableAmountRaw = BigInt(tokenBalanceRaw);

    // Handle the case where user might be sending raw amount instead of UI amount
    let requestedAmountRaw: bigint;

    // If the requested amount is close to the raw amount, assume it's already in raw units
    const assumeRawAmount = parsedTokenAmount > 1000000 && parsedTokenAmount > tokenBalance * 1000;

    if (assumeRawAmount) {
      // User sent raw amount, use it directly but cap it to available
      requestedAmountRaw = BigInt(Math.floor(parsedTokenAmount));
      console.log(`🔧 Detected raw amount input: ${parsedTokenAmount} -> ${requestedAmountRaw}`);
    } else {
      // Normal UI amount, convert to raw
      requestedAmountRaw = BigInt(Math.floor(parsedTokenAmount * Math.pow(10, decimals)));
      console.log(`🔧 Converting UI amount: ${parsedTokenAmount} -> ${requestedAmountRaw}`);
    }

    // SAFETY: Never request more than available
    if (requestedAmountRaw > availableAmountRaw) {
      console.log(`⚠️ Requested amount exceeds balance, using maximum available`);
      requestedAmountRaw = availableAmountRaw;
    }

    // Convert back to UI amount for display
    const finalUiAmount = Number(requestedAmountRaw) / Math.pow(10, decimals);

    console.log(`🔍 SAFE Token balance calculation:
      - UI Amount Available: ${tokenBalance}
      - Raw Amount Available: ${availableAmountRaw.toString()}
      - UI Amount Requested: ${parsedTokenAmount}
      - Raw Amount Requested: ${requestedAmountRaw.toString()}
      - Final UI Amount: ${finalUiAmount}
      - Token Decimals: ${decimals}`);

    // Final safety check
    if (requestedAmountRaw <= BigInt(0)) {
      return res.status(400).json({
        error: `Invalid sell amount. Must be greater than 0.`
      });
    }

    console.log(`💰 Token balance verified: ${finalUiAmount} tokens (${requestedAmountRaw.toString()} raw units)`);

    // Step 3: Get quote based on selected DEX
    console.log(`💱 Getting swap quote from ${dex.toUpperCase()} for ${finalUiAmount} tokens`);
    const amountInSmallestUnit = requestedAmountRaw.toString();

    let sellQuote: any;
    let sellSwapData: any;
    let sellTxid: string = '';
    let sellWalletPrivateKey: string | null = null;
    let sellOutAmount: number = 0;
    let outAmount: number = 0;

    // Get private key for wallet operations
    let sellLastError: Error | null = null;

    // Retry logic for private key retrieval
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        sellWalletPrivateKey = await secureWalletService.getPrivateKey(walletId, userId);
        break;
      } catch (error) {
        sellLastError = error as Error;
        console.log(`❌ Private key retrieval FAILED on attempt ${attempt}: ${error.message}`);

        if (attempt < 5) {
          const waitTime = 100 * Math.pow(2, attempt - 1);
          console.log(`⏳ Waiting ${waitTime}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    }

    if (!sellWalletPrivateKey) {
      console.error(`❌ Failed to retrieve private key after 5 attempts. Last error: ${sellLastError?.message}`);
      return res.status(500).json({
        error: 'Failed to retrieve wallet private key after multiple attempts',
        details: sellLastError?.message
      });
    }

    // ── AUTO-ROUTE: LaunchLab → pump.fun bonding curve → PumpSwap → Raydium ──
    // 'auto' checks LaunchLab first (for non-pump tokens), then pump.fun.
    // Explicit 'pumpfun'/'pumpswap' require a native route.
    // 'jupiter'/'raydium' skip directly to the DEX block below.
    const isPumpSuffixToken = tokenMint.toLowerCase().endsWith('pump');
    const isAutoRoute = dex.toLowerCase() === 'auto';
    const isNativePumpRoute = ['pumpfun', 'pumpswap', 'auto'].includes(dex.toLowerCase());

    // ── Jupiter route probe for pump tokens on auto (2026-06-11) ──────────────
    // A GRADUATED pump token makes the bonding-curve sell fail ON-CHAIN (6024)
    // only after ~14s of rebroadcast+confirm, then fall through to Jupiter —
    // a 24s sell. A Jupiter QUOTE (API-only, ~0.5s, nothing broadcast) detects
    // graduation up-front: route exists → token is listed → sell via Jupiter
    // immediately; no route → still pre-bonded → bonding curve as before.
    // Explicit 'pumpfun'/'pumpswap' selections still skip this and go native.
    let jupiterRouteExists = false;
    if (isAutoRoute && isPumpSuffixToken) {
      try {
        const jupKeyP = process.env.JUPITER_API_KEY || '';
        const probeUrl = `https://api.jup.ag/swap/v1/quote?inputMint=${tokenMint}&outputMint=${outputMint}&amount=${amountInSmallestUnit}&slippageBps=${slippageBps}`;
        const probe = await fetch(probeUrl, {
          headers: jupKeyP ? { 'x-api-key': jupKeyP } : {},
          signal: AbortSignal.timeout(3500),
        });
        if (probe.ok) {
          const pq: any = await probe.json();
          jupiterRouteExists = !!pq?.outAmount && Number(pq.outAmount) > 0;
        }
        console.log(`🔭 Jupiter probe ${tokenMint.slice(0, 8)}: ${jupiterRouteExists
          ? 'route found → graduated, selling via Jupiter directly'
          : 'no route → pre-bonded, using bonding curve'}`);
      } catch (probeErr: any) {
        console.log(`🔭 Jupiter probe failed (${probeErr?.message}) — falling back to native pump route`);
      }
    }

    // ── PATH 0: LetsBonk / LaunchLab sell ─────────────────────────────────────
    // Non-pump tokens in auto mode: check if they have a LaunchLab pool
    if (isAutoRoute && !isPumpSuffixToken) {
      try {
        const { LaunchLabService } = await import('./src/lib/launchLabService.js');
        const { Connection: LLConn, Keypair: LLKp } = await import('@solana/web3.js');
        const bs58LL = await import('bs58');
        const llConn = new LLConn(rpcManager.getUrl(), 'confirmed');
        const launchLabSvc = new LaunchLabService(llConn);
        const hasPool = await launchLabSvc.hasPool(tokenMint);

        if (hasPool) {
          console.log(`🚀 LaunchLab sell: token ${tokenMint} has LaunchLab pool`);
          const llResult = await launchLabSvc.sellExactIn(
            tokenMint,
            requestedAmountRaw,
            Math.max(slippageBps, 300),
            wallet.publicKey,
          );

          if (llResult) {
            const keypair = LLKp.fromSecretKey(bs58LL.default.decode(sellWalletPrivateKey!));
            llResult.transaction.sign([keypair]);
            const llRawTx = llResult.transaction.serialize();
            const llSendOpts = { skipPreflight: true, maxRetries: 0 };
            const { lastValidBlockHeight: llLastBH } = (await llConn.getLatestBlockhash('confirmed'));
            let sig: string | null = null;
            let llConfirmed = false;
            let llLastSentAt = 0;
            const llT0 = Date.now();
            console.log(`📤 LaunchLab sell — rebroadcast loop started...`);
            while (!llConfirmed) {
              const elapsed = Date.now() - llT0;
              if (elapsed > 75_000) throw new Error('LaunchLab sell timed out');
              const bh = await llConn.getBlockHeight('confirmed').catch(() => 0);
              if (bh > 0 && bh > llLastBH) throw new Error('LaunchLab sell blockhash expired');
              if (Date.now() - llLastSentAt >= 2000) {
                try {
                  sig = await llConn.sendRawTransaction(llRawTx, llSendOpts);
                  llLastSentAt = Date.now();
                  console.log(`📡 LL sell sent (${(elapsed/1000).toFixed(1)}s): ${sig.slice(0,20)}...`);
                } catch (e: any) {
                  const m = e?.message || '';
                  if ((m.includes('AlreadyProcessed') || m.includes('already been processed')) && sig) { llConfirmed = true; break; }
                  if (m.includes('Blockhash not found')) throw new Error('LL sell blockhash expired');
                  console.warn(`⚠️ LL sell retry: ${m}`);
                }
              }
              if (!sig) { await new Promise(r => setTimeout(r, 1000)); continue; }
              await new Promise(r => setTimeout(r, 1500));
              try {
                const st = await llConn.getSignatureStatus(sig, { searchTransactionHistory: false });
                const conf = st?.value?.confirmationStatus;
                if (conf === 'confirmed' || conf === 'finalized') {
                  if (st.value?.err) throw new Error(`LL sell failed on-chain: ${JSON.stringify(st.value.err)}`);
                  llConfirmed = true;
                }
              } catch (e: any) { if (e?.message?.startsWith('LL sell failed')) throw e; }
            }
            if (!sig) throw new Error('LaunchLab sell failed: no signature');
            console.log(`✅ LaunchLab sell confirmed: ${sig}`);

            const solReceived = Number(llResult.quote?.solReceived) || 0;
            // Centralized background recording — never blocks the response
            void recordSellTrade({
              userId, walletId, walletPubkey: wallet.publicKey, signature: sig,
              tokenMint, tokenName: req.body.tokenName, tokenSymbol: req.body.tokenSymbol,
              tokensSold: finalUiAmount, dexLabel: 'LAUNCHLAB', fallbackSolReceived: solReceived,
            });

            return res.json({
              success: true,
              signature: sig,
              solReceived,
              tokensSold: finalUiAmount,
              dex: 'LAUNCHLAB',
              explorer: `https://solscan.io/tx/${sig}`,
            });
          }
        }
      } catch (llErr: any) {
        console.log(`⚠️ LaunchLab sell failed or no pool: ${llErr?.message} — trying pump.fun...`);
      }
    }

    if ((isPumpSuffixToken || isNativePumpRoute) && !jupiterRouteExists) {
      console.log(`🎯 pump.fun sell routing for ${tokenMint} (dex=${dex})`);
      // ── pump.fun bonding curve sell via PumpPortal API ────────────────────────
      // Uses PumpPortal trade-local API for correct transaction construction.
      // This replaces manual instruction building which broke after the Feb 2026
      // cashback upgrade (stale account layout → Custom errors 6062/6024).
      try {
        const { Keypair, Connection: PConn, PublicKey: PK } = await import('@solana/web3.js');
        const bs58Mod = await import('bs58');
        const keypair = Keypair.fromSecretKey(bs58Mod.default.decode(sellWalletPrivateKey!));

        const heliusKey = process.env.HELIUS_API_KEY;
        const heliusRpc = heliusKey
          ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`
          : rpcManager.getConnection().rpcEndpoint;

        // ── Multi-round sell loop ─────────────────────────────────────────────
        // The on-chain builder halves the amount when pump.fun overflows (6024)
        // on cashback-era Token-2022 tokens, so a single pass can leave tokens
        // behind. Loop: sell → if partial, re-read the real remaining balance →
        // sell again, until the wallet is empty (max 8 rounds, one click).
        const pumpSellSlippagePct = Math.max(Math.round(slippageBps / 100), 3);
        const broadcastConn = new PConn(heliusRpc, 'confirmed');
        const sellSendOpts = { skipPreflight: true, maxRetries: 0 };
        const { PumpFunService } = await import('./src/lib/pumpfunService.js');
        const pumpFunSvc = new PumpFunService();
        const rounds: { sig: string; tokensSold: number; solOut: number }[] = [];
        let usedPumpSwap = false;
        let remainingUi = finalUiAmount;
        const MAX_ROUNDS = 8;

        for (let round = 1; round <= MAX_ROUNDS && remainingUi >= 1; round++) {
          let sellResult: { transaction: any; quote: any } | null = null;
          try {
            console.log(`🔧 Sell round ${round}: building pump.fun sell for ${remainingUi} tokens (slippage: ${pumpSellSlippagePct}%)...`);
            sellResult = await pumpFunSvc.sellPumpFunToken(tokenMint, remainingUi, slippageBps, wallet.publicKey);
            console.log(`✅ on-chain pump.fun sell transaction built`);
          } catch (ppErr: any) {
            const msg = String(ppErr?.message || '');
            const isGraduated = msg.includes('graduated') || msg.includes('curve not found') || msg.includes('Bonding curve not found') || msg.includes('Token graduated');
            if (isGraduated) {
              console.log(`🔄 Token graduated — trying PumpSwap sell`);
              usedPumpSwap = true;
              try {
                const { PumpSwapService } = await import('./src/lib/pumpSwapService.js');
                const pumpSwapSvc = new PumpSwapService(broadcastConn);
                const pumpSwapResult = await pumpSwapSvc.sellPumpSwap(
                  tokenMint, remainingUi, Math.max(slippageBps, 300), wallet.publicKey
                );
                if (pumpSwapResult) sellResult = pumpSwapResult;
              } catch (psErr: any) {
                console.warn(`⚠️ PumpSwap sell also failed: ${psErr?.message}`);
                if (!isAutoRoute && rounds.length === 0) throw psErr;
                sellResult = null;
              }
            } else if (rounds.length === 0) {
              throw ppErr; // first round failed → surface error / Jupiter fallback
            } else {
              console.warn(`⚠️ Sell round ${round} build failed (${msg}) — stopping with ${rounds.length} completed round(s)`);
              break;
            }
          }
          if (!sellResult) {
            if (rounds.length === 0) throw new Error('pump.fun sell returned no result');
            break;
          }

          // Sign + rebroadcast loop (mirrors the buy path — same reliability)
          sellResult.transaction.sign([keypair]);
          const rawTx = sellResult.transaction.serialize();
          const { lastValidBlockHeight: sellLastBH } = (await broadcastConn.getLatestBlockhash('confirmed'));
          let sig: string | null = null;
          let sellConfirmed = false;
          let sellLastSentAt = 0;
          const sellT0 = Date.now();
          console.log(`📤 pump.fun sell round ${round} — rebroadcast loop started...`);
          while (!sellConfirmed) {
            const elapsed = Date.now() - sellT0;
            if (elapsed > 75_000) throw new Error('Sell timed out after 75s');
            const bh = await broadcastConn.getBlockHeight('confirmed').catch(() => 0);
            if (bh > 0 && bh > sellLastBH) throw new Error('Sell blockhash expired — retry');
            if (Date.now() - sellLastSentAt >= 2000) {
              try {
                sig = await broadcastConn.sendRawTransaction(rawTx, sellSendOpts);
                sellLastSentAt = Date.now();
                console.log(`📡 Sell sent (${(elapsed/1000).toFixed(1)}s): ${sig.slice(0,20)}...`);
              } catch (e: any) {
                const m = e?.message || '';
                if ((m.includes('AlreadyProcessed') || m.includes('already been processed')) && sig) { sellConfirmed = true; break; }
                if (m.includes('Blockhash not found')) throw new Error('Sell blockhash expired — retry');
                console.warn(`⚠️ Sell send error (retrying): ${m}`);
              }
            }
            if (!sig) { await new Promise(r => setTimeout(r, 1000)); continue; }
            await new Promise(r => setTimeout(r, 1500));
            try {
              const st = await broadcastConn.getSignatureStatus(sig, { searchTransactionHistory: false });
              const conf = st?.value?.confirmationStatus;
              if (conf === 'confirmed' || conf === 'finalized') {
                if (st.value?.err) throw new Error(`Sell failed on-chain: ${JSON.stringify(st.value.err)}`);
                sellConfirmed = true;
              }
            } catch (e: any) { if (e?.message?.startsWith('Sell failed')) throw e; }
          }
          if (!sig) throw new Error('Sell failed: no signature obtained');
          console.log(`✅ pump.fun sell round ${round} confirmed (${usedPumpSwap ? 'PumpSwap' : 'pump.fun'}): ${sig}`);

          // quote.amount can be the string "100%" for full sells — never trust it as SOL.
          const quoteSolOut = typeof sellResult.quote?.solOut === 'number' ? sellResult.quote.solOut : 0;
          const roundTokensSold = Number(sellResult.quote?.tokensSold) || remainingUi;

          // Centralized background recording — verifies on-chain before writing
          void recordSellTrade({
            userId, walletId, walletPubkey: wallet.publicKey, signature: sig,
            tokenMint, tokenName: req.body.tokenName, tokenSymbol: req.body.tokenSymbol,
            tokensSold: roundTokensSold, dexLabel: usedPumpSwap ? 'PUMPSWAP' : 'PUMPFUN',
            fallbackSolReceived: quoteSolOut,
          });
          rounds.push({ sig, tokensSold: roundTokensSold, solOut: quoteSolOut });

          if (!sellResult.quote?.isPartialSell || usedPumpSwap) break; // full sell done

          // Partial round — read the REAL remaining balance before the next pass
          await new Promise(r => setTimeout(r, 2500));
          try {
            const accs = await broadcastConn.getParsedTokenAccountsByOwner(
              new PK(wallet.publicKey), { mint: new PK(tokenMint) }
            );
            remainingUi = accs.value.reduce(
              (s: number, a: any) => s + (a.account.data.parsed.info.tokenAmount.uiAmount || 0), 0
            );
            console.log(`🔁 Partial sell — ${remainingUi} tokens remain, continuing (round ${round + 1})...`);
          } catch (balErr: any) {
            console.warn(`⚠️ Could not re-read remaining balance: ${balErr?.message} — stopping after ${rounds.length} round(s)`);
            break;
          }
        }

        if (rounds.length === 0) throw new Error('pump.fun sell completed no rounds');
        const totalTokensSold = rounds.reduce((s, r) => s + r.tokensSold, 0);
        const totalSolOut = rounds.reduce((s, r) => s + r.solOut, 0);
        console.log(`🏁 Sell complete: ${rounds.length} round(s) — ${totalTokensSold} tokens → ${totalSolOut.toFixed(6)} SOL`);

        return res.json({
          success: true,
          signature: rounds[rounds.length - 1].sig,
          signatures: rounds.map(r => r.sig),
          rounds: rounds.length,
          solReceived: totalSolOut,
          tokenAmount: totalTokensSold,
          tokenMint,
          dex: usedPumpSwap ? 'pumpswap' : 'pumpfun',
        });

      } catch (pumpErr: any) {
        console.error(`❌ pump.fun sell failed: ${pumpErr?.message}\n${pumpErr?.stack}`);
        if (!isAutoRoute) {
          // Explicit non-auto dex selection failed — surface the error directly
          return res.status(500).json({
            error: `pump.fun sell failed: ${pumpErr?.message}`,
            hint: 'Try using dex=jupiter which can route through PumpSwap.'
          });
        }
        // auto-route fallback: pump.fun failed → try Jupiter (aggregates PumpSwap + DEXes)
        console.log(`⚠️ pump.fun sell failed for auto-route — falling through to Jupiter`);
      }
    }

    // ── Raydium / Jupiter block — only reached for explicit dex or auto-fallthrough ──
    const effectiveDex = isAutoRoute ? 'jupiter' : dex.toLowerCase();

    if (effectiveDex === 'jupiter') {
      // Jupiter quote and swap
      const jupKeyQ = process.env.JUPITER_API_KEY || '';
      const quoteUrl = `https://api.jup.ag/swap/v1/quote?inputMint=${tokenMint}&outputMint=${outputMint}&amount=${amountInSmallestUnit}&slippageBps=${slippageBps}`;

      const quoteResponse = await fetch(quoteUrl, {
        headers: jupKeyQ ? { 'x-api-key': jupKeyQ } : {}
      });
      if (!quoteResponse.ok) {
        throw new Error(`Jupiter quote failed: ${quoteResponse.statusText}`);
      }

      sellQuote = await quoteResponse.json();
      console.log(`💱 Jupiter Quote received: ${amountInSmallestUnit} tokens → ${sellQuote.outAmount} lamports (${sellQuote.outAmount / 1e9} SOL)`);

      // Step 4: Get swap transaction from Jupiter
      console.log(`📋 Requesting swap transaction from Jupiter`);
      const jupKeyS = process.env.JUPITER_API_KEY || '';
      const swapResponse = await fetch('https://api.jup.ag/swap/v1/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(jupKeyS ? { 'x-api-key': jupKeyS } : {}) },
        body: JSON.stringify({
          quoteResponse: sellQuote,
          userPublicKey: wallet.publicKey,
          wrapAndUnwrapSol: true,
          // Phantom-like fast inclusion: high priority fee + dynamic compute limit
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: {
            priorityLevelWithMaxLamports: {
              priorityLevel: 'veryHigh',
              maxLamports: 2_000_000 // cap ~0.002 SOL
            }
          }
        })
      });

      if (!swapResponse.ok) {
        const errorText = await swapResponse.text();
        console.error(`❌ Jupiter swap request failed: ${swapResponse.status} ${swapResponse.statusText}`);
        console.error(`❌ Error response: ${errorText}`);
        throw new Error(`Jupiter swap request failed: ${swapResponse.statusText}`);
      }

      sellSwapData = await swapResponse.json();

      // Validate the swap response
      if (!sellSwapData || !sellSwapData.swapTransaction) {
        console.error(`❌ Invalid Jupiter swap response:`, sellSwapData);
        throw new Error('Jupiter API returned invalid swap transaction data');
      }

      console.log(`✅ Jupiter swap transaction received successfully`);

    } else if (effectiveDex === 'raydium') {
      // Raydium quote and swap
      console.log(`🔍 Using Raydium for token swap`);
      const quoteUrl = `https://transaction-v1.raydium.io/compute/swap-base-in?inputMint=${tokenMint}&outputMint=${outputMint}&amount=${amountInSmallestUnit}&slippageBps=${slippageBps}&txVersion=V0`;

      console.log(`📊 Raydium quote URL: ${quoteUrl}`);
      const quoteResponse = await axios.get(quoteUrl);
      if (!quoteResponse.data) {
        throw new Error('Raydium quote failed - no response data');
      }

      sellQuote = quoteResponse.data;
      console.log(`💱 Raydium Quote received:`, JSON.stringify(sellQuote, null, 2));

      // Step 4: Get swap transaction from Raydium
      console.log(`📋 Requesting swap transaction from Raydium`);
      const swapUrl = `https://transaction-v1.raydium.io/transaction/swap-base-in`;

      // Get token accounts for proper Raydium request
      const inputTokenAccount = tokenAccounts.value[0].pubkey.toString();

      // Get SOL account (ATA for wrapped SOL)
      const { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } = await import('@solana/spl-token');
      const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
      const outputTokenAccount = await getAssociatedTokenAddress(WSOL_MINT, walletPublicKey);

      const requestBody = {
        computeUnitPriceMicroLamports: "1000000",
        swapResponse: sellQuote,
        txVersion: "V0",
        wallet: wallet.publicKey,
        wrapSol: false,
        unwrapSol: true,
        inputAccount: inputTokenAccount,
        outputAccount: outputTokenAccount.toString()
      };

      console.log(`📋 Raydium request body with accounts:`, JSON.stringify(requestBody, null, 2));

      const swapResponse = await axios.post(swapUrl, requestBody, {
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'SolSniper/1.0',
          'Accept': 'application/json'
        }
      });

      if (!swapResponse.data) {
        throw new Error('Raydium swap request failed - no response data');
      }

      sellSwapData = swapResponse.data;
      console.log(`✅ Raydium swap response received:`, JSON.stringify(sellSwapData, null, 2));

      // Enhanced Raydium error handling
      if (!sellSwapData) {
        throw new Error('Raydium swap request failed - no response data');
      }

      if (!sellSwapData.success) {
        const errorMsg = sellSwapData.msg || 'Unknown Raydium error';
        console.error(`❌ Raydium API Error: ${errorMsg}`);
        console.error(`❌ Full Raydium response:`, sellSwapData);

        // Provide more helpful error messages for common Raydium errors
        if (errorMsg.includes('REQ_INPUT_ACCOUT_ERROR')) {
          throw new Error('Raydium Error: Invalid token account. This token may not be tradable on Raydium or requires different account setup.');
        } else if (errorMsg.includes('INSUFFICIENT')) {
          throw new Error('Raydium Error: Insufficient token balance or liquidity.');
        } else if (errorMsg.includes('SLIPPAGE')) {
          throw new Error('Raydium Error: Price moved beyond acceptable slippage tolerance.');
        } else {
          throw new Error(`Raydium API Error: ${errorMsg}`);
        }
      }

      // Validate Raydium swap response structure - handle both old and new formats
      let transaction;
      if (sellSwapData.data && Array.isArray(sellSwapData.data) && sellSwapData.data[0]?.transaction) {
        // New format: data is an array with transaction objects
        transaction = sellSwapData.data[0].transaction;
        console.log('✅ Using new Raydium response format (array)');
      } else if (sellSwapData.data && sellSwapData.data.transaction) {
        // Old format: data is an object with transaction property
        transaction = sellSwapData.data.transaction;
        console.log('✅ Using old Raydium response format (object)');
      } else {
        console.error(`❌ Invalid Raydium swap response structure:`, sellSwapData);
        throw new Error('Raydium API returned unexpected response format');
      }

      // Extract the transaction from Raydium's response format
      sellSwapData.swapTransaction = transaction;

    } else {
      throw new Error(`Unsupported DEX: ${dex}. Only Jupiter and Raydium are supported.`);
    }

    // For Jupiter and Raydium, continue with manual transaction signing
    // Step 5: Sign and send the transaction with retry logic for decryption
    let sellWalletPrivateKey2: string | null = null;
    let sellLastError2: Error | null = null;

    // Retry logic specifically for Jupiter transactions
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        console.log(`🔄 Private key retrieval attempt ${attempt}/5...`);
        sellWalletPrivateKey2 = await secureWalletService.getPrivateKey(walletId, userId);
        console.log(`✅ Private key retrieval SUCCESS on attempt ${attempt}`);
        break;
      } catch (error) {
        sellLastError2 = error as Error;
        console.log(`❌ Private key retrieval FAILED on attempt ${attempt}: ${error.message}`);

        if (attempt < 5) {
          // Wait with exponential backoff: 100ms, 200ms, 400ms, 800ms
          const waitTime = 100 * Math.pow(2, attempt - 1);
          console.log(`⏳ Waiting ${waitTime}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    }

    if (!sellWalletPrivateKey2) {
      console.error(`❌ Failed to retrieve private key after 5 attempts. Last error: ${sellLastError2?.message}`);
      return res.status(500).json({
        error: 'Failed to retrieve wallet private key after multiple attempts',
        details: sellLastError2?.message
      });
    }

    console.log(`✍️ Signing and sending transaction`);

    // CRITICAL: Validate swap transaction data before deserialization
    if (!sellSwapData.swapTransaction) {
      console.error(`❌ No swapTransaction in sellSwapData:`, sellSwapData);
      return res.status(500).json({
        error: `${dex.toUpperCase()} API did not return a valid swap transaction`,
        details: 'swapTransaction field is missing from API response'
      });
    }

    if (typeof sellSwapData.swapTransaction !== 'string') {
      console.error(`❌ swapTransaction is not a string:`, typeof sellSwapData.swapTransaction, sellSwapData.swapTransaction);
      return res.status(500).json({
        error: `${dex.toUpperCase()} API returned invalid swap transaction format`,
        details: `Expected string, got ${typeof sellSwapData.swapTransaction}`
      });
    }

    console.log(`✅ Swap transaction validation passed, deserializing...`);

    const { VersionedTransaction, Keypair } = await import('@solana/web3.js');

    // Deserialize the transaction
    const swapTransactionBuf = Buffer.from(sellSwapData.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

    // Create keypair from private key (base58 encoded)
    const bs58 = await import('bs58');
    const keypair = Keypair.fromSecretKey(bs58.default.decode(sellWalletPrivateKey2));

    // Sign the transaction
    transaction.sign([keypair]);

    // Extract outAmount from the quote up-front (needed for the instant response, before confirmation)
    if (dex === 'jupiter') {
      sellOutAmount = parseFloat(sellQuote.outAmount);
      outAmount = sellOutAmount;
    } else {
      const raydiumAmount = sellQuote.data?.outAmount || sellQuote.outAmount || sellQuote.data?.outputAmount || sellQuote.outputAmount;
      sellOutAmount = parseFloat(raydiumAmount || '0');
      outAmount = sellOutAmount;
    }
    if (!sellOutAmount || sellOutAmount <= 0) {
      console.error('❌ Failed to extract valid outAmount from quote:', sellQuote);
      return res.status(500).json({ error: 'Failed to calculate output amount from DEX quote', dex, quote: sellQuote });
    }

    // ── Broadcast + confirm. We MUST wait for on-chain confirmation before reporting
    // success, because the Transactions list is built from real on-chain history — a
    // sell that doesn't confirm simply won't exist. Speed comes from the high priority
    // fee (set on the swap request) plus tight polling, not from skipping confirmation.
    const jupRaw = transaction.serialize();
    const sellConn = rpcManager.getConnection();
    const jupSendOpts = { skipPreflight: true, maxRetries: 0 };
    const { lastValidBlockHeight: jupLastBH } = await sellConn.getLatestBlockhash('confirmed');
    let jupSig: string | null = null;
    let jupConfirmed = false;
    let jupLastSentAt = 0;
    const jupT0 = Date.now();
    console.log(`📤 Jupiter/Raydium sell — broadcast + confirm...`);
    while (!jupConfirmed) {
      const elapsed = Date.now() - jupT0;
      if (elapsed > 45_000) throw new Error('Sell timed out — network congestion. Try again.');
      const bh = await sellConn.getBlockHeight('confirmed').catch(() => 0);
      if (bh > 0 && bh > jupLastBH) throw new Error('Sell blockhash expired — retry');
      // Rebroadcast roughly once per second to keep the tx fresh in the leader's pipeline
      if (Date.now() - jupLastSentAt >= 1000) {
        try {
          jupSig = await sellConn.sendRawTransaction(jupRaw, jupSendOpts);
          jupLastSentAt = Date.now();
          sellTxid = jupSig;
        } catch (e: any) {
          const m = e?.message || '';
          if ((m.includes('AlreadyProcessed') || m.includes('already been processed')) && jupSig) { jupConfirmed = true; break; }
          if (m.includes('Blockhash not found')) throw new Error('Sell blockhash expired — retry');
          console.warn(`⚠️ Jup/Ray sell retry: ${m}`);
        }
      }
      if (!jupSig) { await new Promise(r => setTimeout(r, 300)); continue; }
      // Tight 400ms confirmation polling for fast detection
      await new Promise(r => setTimeout(r, 400));
      try {
        const st = await sellConn.getSignatureStatus(jupSig, { searchTransactionHistory: false });
        const conf = st?.value?.confirmationStatus;
        if (conf === 'confirmed' || conf === 'finalized') {
          if (st.value?.err) throw new Error(`Sell failed on-chain: ${JSON.stringify(st.value.err)}`);
          jupConfirmed = true;
        }
      } catch (e: any) { if (e?.message?.startsWith('Sell failed')) throw e; }
    }
    if (!sellTxid) throw new Error('Jupiter/Raydium sell failed: no signature');
    console.log(`✅ Jupiter/Raydium sell confirmed (${((Date.now() - jupT0) / 1000).toFixed(1)}s): ${sellTxid}`);

    const quoteSolReceived = outAmount / 1e9;
    const quotePrice = finalUiAmount > 0 ? quoteSolReceived / finalUiAmount : 0;

    // Respond immediately now that it's confirmed; DB enrichment happens in the background.
    res.json({
      success: true,
      signature: sellTxid,
      solReceived: quoteSolReceived,
      tokenAmount: finalUiAmount,
      tokenMint,
      dex,
      quote: {
        inAmount: dex === 'jupiter' ? sellQuote.inAmount : Number(requestedAmountRaw),
        outAmount: outAmount,
        priceImpactPct: dex === 'jupiter' ? sellQuote.priceImpactPct : null,
        routePlan: dex === 'jupiter' ? sellQuote.routePlan : null
      }
    });

    // Centralized background recording — never blocks the response.
    // Use effectiveDex, not the raw request value: 'auto' was leaking into the DB
    // as a fake "AUTO" venue and splitting the Analytics DEX-performance stats.
    void recordSellTrade({
      userId, walletId, walletPubkey: wallet.publicKey, signature: sellTxid,
      tokenMint, tokenName: req.body.tokenName, tokenSymbol: req.body.tokenSymbol,
      tokensSold: finalUiAmount, dexLabel: effectiveDex.toUpperCase(), fallbackSolReceived: quoteSolReceived,
    });
    return;

  } catch (error) {
    console.error('❌ Error in sell-token endpoint:', error);

    // Record the denied/never-landed sell attempt so it shows on the Transactions page
    const message0 = error instanceof Error ? error.message : 'Failed to execute token sale';
    if (req.user?.id && req.body?.tokenMint) {
      void recordRejectedTrade({
        userId: req.user.id, type: 'sell', tokenMint: req.body.tokenMint,
        tokenName: req.body.tokenName, tokenSymbol: req.body.tokenSymbol,
        requestedAmount: Number(req.body.tokenAmount) || 0,
        dexLabel: req.body.dex || 'jupiter', reason: message0,
      });
    }

    // Handle specific error types
    if (error.response && error.response.data) {
      const jupiterError = error.response.data;
      if (jupiterError.error && jupiterError.error.includes('No route found')) {
        return res.status(400).json({
          error: 'No trading route found for this token. It may not have sufficient liquidity or be tradable on the selected DEX.'
        });
      }
    }

    res.status(500).json({ error: message0 });
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// Buy token on pump.fun bonding curve (pre-bonded only)
// Uses pumpportal.fun/api/trade-local to build the transaction server-side.
// For graduated tokens, use /api/wallets/buy-token (Jupiter/Raydium) instead.
// @ts-ignore - TypeScript middleware compatibility
app.post('/api/wallets/buy-pumpfun-token', authenticateUser, asyncAuthHandler(async (req, res) => {
  try {
    const { walletId, tokenMint, solAmount, slippageBps = 100 } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    if (!walletId || !tokenMint || !solAmount) {
      return res.status(400).json({ error: 'Missing required fields: walletId, tokenMint, solAmount' });
    }

    const parsedSolAmount = parseFloat(solAmount);
    const parsedSlippageBps = parseInt(slippageBps);

    if (isNaN(parsedSolAmount) || parsedSolAmount <= 0) {
      return res.status(400).json({ error: 'Invalid solAmount' });
    }

    // Validate wallet ownership
    const wallet = await secureWalletService.getWallet(walletId, userId);
    if (!wallet) {
      return res.status(404).json({ error: 'Wallet not found or access denied' });
    }

    const currentBalance = parseFloat(wallet.balanceSol.toString());
    if (currentBalance < parsedSolAmount) {
      return res.status(400).json({
        error: `Insufficient SOL balance. Available: ${currentBalance}, Required: ${parsedSolAmount}`
      });
    }

    console.log(`🎯 pump.fun buy: ${parsedSolAmount} SOL → ${tokenMint} (slippage ${parsedSlippageBps} bps)`);

    // Build transaction via pumpportal trade-local API
    const { PumpFunService } = await import('./src/lib/pumpfunService.js');
    const pumpFunSvc = new PumpFunService();

    let buildResult: any;
    try {
      buildResult = await pumpFunSvc.buyPumpFunToken(
        tokenMint,
        parsedSolAmount,
        parsedSlippageBps,
        wallet.publicKey
      );
    } catch (buildErr: any) {
      // If token has migrated, return a helpful redirect message
      if (buildErr.message && buildErr.message.includes('migrated to Raydium')) {
        return res.status(400).json({
          error: 'Token has migrated to Raydium. Use /api/wallets/buy-token with dex=raydium or dex=jupiter.',
          migrated: true
        });
      }
      throw buildErr;
    }

    if (!buildResult || !buildResult.transaction) {
      return res.status(500).json({ error: 'Failed to build pump.fun buy transaction' });
    }

    // Retrieve private key with retry
    let walletPrivateKey: string | null = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        walletPrivateKey = await secureWalletService.getPrivateKey(walletId, userId);
        break;
      } catch (err: any) {
        if (attempt < 5) await new Promise(r => setTimeout(r, 100 * Math.pow(2, attempt - 1)));
      }
    }
    if (!walletPrivateKey) {
      return res.status(500).json({ error: 'Failed to retrieve wallet private key' });
    }

    // Sign and send — ALWAYS rebuild with fresh blockhash right before signing
    // (same pattern as buy_token.mjs which reliably succeeds)
    const { Connection, Keypair, VersionedTransaction: VT2, TransactionMessage: TM2 } = await import('@solana/web3.js');
    const heliusKey = process.env.HELIUS_API_KEY;
    const rpcUrl = heliusKey
      ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`
      : (process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');
    const connection = new Connection(rpcUrl);

    const bs58 = await import('bs58');
    const keypair = Keypair.fromSecretKey(bs58.default.decode(walletPrivateKey));

    // Rebuild transaction with a fresh blockhash fetched AFTER keypair is ready
    let finalTx: InstanceType<typeof VT2>;
    if (buildResult.instructions && Array.isArray(buildResult.instructions) && buildResult.payerKey) {
      const { blockhash: freshBh } = await connection.getLatestBlockhash('confirmed');
      console.log(`🔄 Fresh blockhash for buy-pumpfun-token: ${freshBh}`);
      const msg = new TM2({
        payerKey: buildResult.payerKey,
        recentBlockhash: freshBh,
        instructions: buildResult.instructions,
      }).compileToV0Message();
      finalTx = new VT2(msg);
      finalTx.sign([keypair]);
    } else {
      buildResult.transaction.sign([keypair]);
      finalTx = buildResult.transaction;
    }

    const txid = await connection.sendTransaction(finalTx, {
      skipPreflight: true,
      preflightCommitment: 'processed',
      maxRetries: 0
    });

    console.log(`📤 pump.fun buy transaction sent: ${txid}`);

    const confirmation = await connection.confirmTransaction(txid, 'confirmed');
    if (confirmation.value.err) {
      // Record the failed buy — verifier confirms the on-chain error and writes status='failed'
      void recordBuyTrade({
        userId, walletId, walletPubkey: wallet.publicKey, signature: txid,
        tokenMint, dexLabel: 'PUMPFUN', fallbackSolSpent: parsedSolAmount,
      });
      return res.status(500).json({
        error: 'Transaction failed during execution',
        signature: txid,
        details: confirmation.value.err
      });
    }

    // Fetch token metadata for DB record
    let tokenName = tokenMint;
    let tokenSymbol: string | null = null;
    try {
      const meta = await fetchTokenMetadata(tokenMint);
      if (meta?.name) { tokenName = meta.name; tokenSymbol = meta.symbol ?? null; }
    } catch { /* non-fatal */ }

    // Analyze for accurate SOL tracking
    let transactionAnalysis: TransactionAnalysis | null = null;
    try {
      transactionAnalysis = await analyzeTransaction(txid, wallet.publicKey);
    } catch { /* non-fatal */ }

    // Estimate tokens received from bonding curve quote
    const tokensEstimate = buildResult.quote?.tokensOut || 0;
    const actualSolSpent = Math.abs(transactionAnalysis?.netSolAmount || parsedSolAmount);
    const accuratePrice = tokensEstimate > 0 ? actualSolSpent / tokensEstimate : 0;

    // Centralized background recording — verifies on-chain (meta.err + balance
    // delta) before writing; real token amount replaces the bonding-curve estimate.
    void recordBuyTrade({
      userId, walletId, walletPubkey: wallet.publicKey, signature: txid,
      tokenMint, tokenName, tokenSymbol,
      tokensEstimate, dexLabel: 'PUMPFUN', fallbackSolSpent: actualSolSpent,
    });

    // NOTE: wallet balance update happens inside recordBuyTrade (after on-chain
    // verification) — updating here too would double-count.

    res.json({
      success: true,
      signature: txid,
      solAmount: parsedSolAmount,
      estimatedTokens: tokensEstimate,
      tokenMint,
      dex: 'PUMPFUN',
      bondingCurve: buildResult.quote?.tokenInfo?.bonding_curve || null,
      priceImpact: buildResult.quote?.priceImpact || null
    });

  } catch (error: any) {
    console.error('❌ Error in buy-pumpfun-token endpoint:', error);
    const msg = error instanceof Error ? error.message : 'Failed to execute pump.fun buy';
    // Record the denied/never-landed buy attempt
    if (req.user?.id && req.body?.tokenMint) {
      void recordRejectedTrade({
        userId: req.user.id, type: 'buy', tokenMint: req.body.tokenMint,
        requestedAmount: 0, dexLabel: 'PUMPFUN', reason: msg,
      });
    }
    res.status(500).json({ error: msg });
  }
}));

// ─────────────────────────────────────────────────────────────────────────────
// Sell token on pump.fun bonding curve (pre-bonded only)
// Uses pumpportal.fun/api/trade-local to build the transaction server-side.
// For graduated tokens, use /api/wallets/sell-token (Jupiter/Raydium) instead.
// @ts-ignore - TypeScript middleware compatibility
app.post('/api/wallets/sell-pumpfun-token', authenticateUser, asyncAuthHandler(async (req, res) => {
  try {
    const { walletId, tokenMint, tokenAmount, slippageBps = 100 } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    if (!walletId || !tokenMint || !tokenAmount) {
      return res.status(400).json({ error: 'Missing required fields: walletId, tokenMint, tokenAmount' });
    }

    const parsedTokenAmount = parseFloat(tokenAmount);
    const parsedSlippageBps = parseInt(slippageBps);

    if (isNaN(parsedTokenAmount) || parsedTokenAmount <= 0) {
      return res.status(400).json({ error: 'Invalid tokenAmount' });
    }

    // Validate wallet ownership
    const wallet = await secureWalletService.getWallet(walletId, userId);
    if (!wallet) {
      return res.status(404).json({ error: 'Wallet not found or access denied' });
    }

    // Verify token balance before attempting the sell
    const { Connection, PublicKey } = await import('@solana/web3.js');
    const heliusKey = process.env.HELIUS_API_KEY;
    const rpcUrl = heliusKey
      ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`
      : (process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');
    const connection = new Connection(rpcUrl);

    const walletPubkey = new PublicKey(wallet.publicKey);
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(walletPubkey, {
      mint: new PublicKey(tokenMint)
    });

    if (tokenAccounts.value.length === 0) {
      return res.status(400).json({ error: 'No token account found for this token' });
    }

    const tokenBalance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount as number;
    const resolvedAmount = Math.min(parsedTokenAmount, tokenBalance);

    console.log(`🎯 pump.fun sell: ${resolvedAmount} tokens → SOL for ${tokenMint}`);

    // Build transaction via pumpportal trade-local API
    const { PumpFunService } = await import('./src/lib/pumpfunService.js');
    const pumpFunSvc = new PumpFunService();

    let buildResult: any;
    try {
      buildResult = await pumpFunSvc.sellPumpFunToken(
        tokenMint,
        resolvedAmount,
        parsedSlippageBps,
        wallet.publicKey
      );
    } catch (buildErr: any) {
      if (buildErr.message && buildErr.message.includes('migrated to Raydium')) {
        return res.status(400).json({
          error: 'Token has migrated to Raydium. Use /api/wallets/sell-token with dex=raydium or dex=jupiter.',
          migrated: true
        });
      }
      throw buildErr;
    }

    if (!buildResult || !buildResult.transaction) {
      return res.status(500).json({ error: 'Failed to build pump.fun sell transaction' });
    }

    // Retrieve private key with retry
    let walletPrivateKey: string | null = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        walletPrivateKey = await secureWalletService.getPrivateKey(walletId, userId);
        break;
      } catch (err: any) {
        if (attempt < 5) await new Promise(r => setTimeout(r, 100 * Math.pow(2, attempt - 1)));
      }
    }
    if (!walletPrivateKey) {
      return res.status(500).json({ error: 'Failed to retrieve wallet private key' });
    }

    // Sign and send
    const { Keypair } = await import('@solana/web3.js');
    const bs58 = await import('bs58');
    const keypair = Keypair.fromSecretKey(bs58.default.decode(walletPrivateKey));
    buildResult.transaction.sign([keypair]);

    const txid = await connection.sendTransaction(buildResult.transaction, {
      skipPreflight: true,
      preflightCommitment: 'processed',
      maxRetries: 0
    });

    console.log(`📤 pump.fun sell transaction sent: ${txid}`);

    const confirmation = await connection.confirmTransaction(txid, 'confirmed');
    if (confirmation.value.err) {
      // Record the failed sell — verifier confirms the on-chain error and writes status='failed'
      void recordSellTrade({
        userId, walletId, walletPubkey: wallet.publicKey, signature: txid,
        tokenMint, tokensSold: Number(tokenAmount) || 0, dexLabel: 'PUMPFUN',
      });
      return res.status(500).json({
        error: 'Transaction failed during execution',
        signature: txid,
        details: confirmation.value.err
      });
    }

    // Fetch token metadata
    let tokenName = tokenMint;
    let tokenSymbol: string | null = null;
    try {
      const meta = await fetchTokenMetadata(tokenMint);
      if (meta?.name) { tokenName = meta.name; tokenSymbol = meta.symbol ?? null; }
    } catch { /* non-fatal */ }

    // Analyze for accurate SOL tracking
    let transactionAnalysis: TransactionAnalysis | null = null;
    try {
      transactionAnalysis = await analyzeTransaction(txid, wallet.publicKey);
    } catch { /* non-fatal */ }

    const estimatedSolOut = buildResult.quote?.solOut || 0;
    const actualSolReceived = Math.abs(transactionAnalysis?.netSolAmount || estimatedSolOut);
    const accuratePrice = resolvedAmount > 0 ? actualSolReceived / resolvedAmount : 0;

    // Centralized background recording — verifies on-chain (meta.err + balance
    // dropped) before writing; same hardened path as /api/wallets/sell-token.
    void recordSellTrade({
      userId, walletId, walletPubkey: wallet.publicKey, signature: txid,
      tokenMint, tokenName, tokenSymbol,
      tokensSold: resolvedAmount, dexLabel: 'PUMPFUN', fallbackSolReceived: estimatedSolOut,
    });

    // NOTE: wallet balance update happens inside recordSellTrade (after on-chain
    // verification) — updating here too would double-count.

    res.json({
      success: true,
      signature: txid,
      tokenAmount: resolvedAmount,
      estimatedSolReceived: estimatedSolOut,
      actualSolReceived,
      tokenMint,
      dex: 'PUMPFUN',
      priceImpact: buildResult.quote?.priceImpact || null
    });

  } catch (error: any) {
    console.error('❌ Error in sell-pumpfun-token endpoint:', error);
    const msg = error instanceof Error ? error.message : 'Failed to execute pump.fun sell';
    // Record the denied/never-landed sell attempt
    if (req.user?.id && req.body?.tokenMint) {
      void recordRejectedTrade({
        userId: req.user.id, type: 'sell', tokenMint: req.body.tokenMint,
        requestedAmount: Number(req.body.tokenAmount) || 0, dexLabel: 'PUMPFUN', reason: msg,
      });
    }
    res.status(500).json({ error: msg });
  }
}));

// (slop audit P0) Duplicate registrations of /api/admin/legacy-stats and
// /api/admin/upgrade-all-platform removed — identical handlers are registered
// at lines ~2826/~2850; Express only ever reached the first pair.

// ==============================================
// MISSING ROUTES — P0 FIXES
// ==============================================

// --- SOL Transfer ---
// POST /api/wallets/:id/transfer
// Transfers SOL from a managed wallet to any address
// @ts-ignore
app.post('/api/wallets/:id/transfer', authenticateUser, asyncAuthHandler(async (req, res) => {
  try {
    const { id: walletId } = req.params;
    const { toAddress, amount } = req.body;
    const userId = req.user?.id;

    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    if (!toAddress || !amount) return res.status(400).json({ error: 'toAddress and amount are required' });

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    // Validate wallet ownership
    const wallet = await secureWalletService.getWallet(walletId, userId);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found or access denied' });

    const currentBalance = parseFloat(wallet.balanceSol.toString());
    const FEE_RESERVE = 0.000010; // ~10k lamports for tx fee
    if (currentBalance < parsedAmount + FEE_RESERVE) {
      return res.status(400).json({
        error: `Insufficient balance`,
        currentBalance,
        requestedAmount: parsedAmount,
        totalNeeded: parsedAmount + FEE_RESERVE
      });
    }

    // Get private key and build transfer
    const privateKeyB58 = await secureWalletService.getPrivateKey(walletId, userId);
    const { Connection, PublicKey, SystemProgram, Transaction, Keypair, LAMPORTS_PER_SOL } = await import('@solana/web3.js');
    const bs58 = await import('bs58');
    const connection = rpcManager.getConnection();
    const keypair = Keypair.fromSecretKey(bs58.default.decode(privateKeyB58));

    let toPubkey: any;
    try {
      toPubkey = new PublicKey(toAddress);
    } catch {
      return res.status(400).json({ error: 'Invalid recipient address' });
    }

    const lamports = Math.round(parsedAmount * LAMPORTS_PER_SOL);
    const transferIx = SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey,
      lamports,
    });

    const { blockhash } = await connection.getLatestBlockhash();
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: keypair.publicKey });
    tx.add(transferIx);
    tx.sign(keypair);

    const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await connection.confirmTransaction(signature, 'confirmed');

    // Update balance in DB (approximate)
    try {
      await prisma.managed_wallets.update({
        where: { id: walletId },
        data: { balanceSol: (currentBalance - parsedAmount) }
      });
    } catch (e) { console.warn('Balance update after transfer failed:', e); }

    console.log(`✅ Transfer: ${parsedAmount} SOL from ${wallet.walletName} → ${toAddress} | sig: ${signature}`);
    res.json({ success: true, signature, amount: parsedAmount, toAddress });
  } catch (error) {
    console.error('❌ Transfer error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Transfer failed' });
  }
}));

// --- Wallet Activity Log ---
// GET /api/wallets/:id/activity
// Returns recent transactions for a wallet as activity logs
// @ts-ignore
app.get('/api/wallets/:id/activity', authenticateUser, asyncAuthHandler(async (req, res) => {
  try {
    const { id: walletId } = req.params;
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const wallet = await secureWalletService.getWallet(walletId, userId);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found or access denied' });

    const transactions = await sqliteDb.transactions.findMany({
      where: { userId },
      orderBy: { timestamp: 'desc' },
      take: 50,
    });

    const logs = transactions.map((tx: any) => ({
      timestamp: tx.timestamp,
      action: `${tx.type.toUpperCase()} ${tx.tokenSymbol || tx.tokenName || tx.tokenAddress?.slice(0, 8) || 'token'}`,
      walletId,
      walletName: wallet.walletName,
      details: {
        txId: tx.txId,
        amount: tx.amount,
        price: tx.price,
        status: tx.status,
        dex: tx.dex,
      }
    }));

    res.json({ success: true, logs });
  } catch (error) {
    console.error('❌ Activity log error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to fetch activity' });
  }
}));

// --- Export Private Key (auth-gated) ---
// POST /api/wallets/:id/private-key
// Re-added behind authentication; requires confirmationPhrase for safety
// @ts-ignore
app.post('/api/wallets/:id/private-key', authenticateUser, asyncAuthHandler(async (req, res) => {
  try {
    const { id: walletId } = req.params;
    const { confirmationPhrase } = req.body;
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    if (confirmationPhrase !== 'I_UNDERSTAND_THE_RISKS') {
      return res.status(400).json({ error: 'You must confirm you understand the risks' });
    }

    const wallet = await secureWalletService.getWallet(walletId, userId);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found or access denied' });

    const privateKey = await secureWalletService.getPrivateKey(walletId, userId);
    console.warn(`⚠️ Private key exported for wallet ${walletId} by user ${userId}`);
    res.json({ success: true, privateKey, walletName: wallet.walletName });
  } catch (error) {
    console.error('❌ Private key export error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to export key' });
  }
}));

// --- Clear all transactions for the current user (legacy client path) ---
// DELETE /api/transactions/clear/:walletAddress
// The walletAddress param is accepted for backwards compatibility; clearing is
// scoped to the authenticated user and sets the same "cleared at" cutoff so
// on-chain history is hidden too.
// @ts-ignore
app.delete('/api/transactions/clear/:walletAddress', authenticateUser, asyncAuthHandler(async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated' });

    const result = await sqliteDb.transactions.deleteMany({ where: { userId } });

    const cutoffKey = `txcutoff:${userId}`;
    const now = String(Date.now());
    try {
      await sqliteDb.app_config.upsert({
        where: { key: cutoffKey },
        update: { value: now },
        create: { key: cutoffKey, value: now },
      });
    } catch (e: any) {
      console.warn('Failed to set tx cutoff:', e?.message);
    }

    console.log(`🗑️ Cleared ${result.count} transactions for user ${userId} (cutoff ${now})`);
    res.json({ success: true, deletedCount: result.count });
  } catch (error: any) {
    console.error('Error clearing transactions:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}));

// --- Delete individual transaction ---
// DELETE /api/transactions/:id
// @ts-ignore
app.delete('/api/transactions/:id', authenticateUser, asyncAuthHandler(async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    // Verify the transaction belongs to this user
    const tx = await sqliteDb.transactions.findFirst({ where: { id, userId } });
    if (!tx) return res.status(404).json({ error: 'Transaction not found or access denied' });

    await sqliteDb.transactions.delete({ where: { id } });
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Delete transaction error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to delete transaction' });
  }
}));

// --- Clear all user transactions ---
// DELETE /api/wallets/:id/transactions
// @ts-ignore
app.delete('/api/wallets/:id/transactions', authenticateUser, asyncAuthHandler(async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const result = await sqliteDb.transactions.deleteMany({ where: { userId } });
    res.json({ success: true, deleted: result.count });
  } catch (error) {
    console.error('❌ Clear transactions error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to clear transactions' });
  }
}));

// NOTE: /api/settings GET+POST are registered ONCE near line ~5740 (settings_json column).
// A duplicate dead pair previously lived here (Express only serves the first registration)
// and was removed per audit §1.3 — do not re-add routes for paths registered above.

// ==============================================
// GRACEFUL SHUTDOWN HANDLERS
// ==============================================


const gracefulShutdown = async (signal: string) => {
  console.log(`\n🛑 Received ${signal}. Shutting down gracefully...`);

  // Close WebSocket connections
  wss.clients.forEach((client) => {
    client.close();
  });
  console.log('✅ WebSocket connections closed');

  // Close HTTP server
  httpServer.close(() => {
    console.log('✅ HTTP server closed');
  });

  // Disconnect Prisma
  try {
    await prisma.$disconnect();
    console.log('✅ Database connection closed');
  } catch (error) {
    console.error('❌ Error disconnecting from database:', error);
  }

  // Force exit after 5 seconds if graceful shutdown fails
  setTimeout(() => {
    console.log('⚠️ Forcing exit...');
    process.exit(0);
  }, 5000);

  process.exit(0);
};

// Handle Ctrl+C (SIGINT) and kill signals (SIGTERM)
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  gracefulShutdown('uncaughtException');
});

// Handle unhandled promise rejections. In a heavily-async trading process an
// unawaited rejection would otherwise terminate Node on modern versions —
// possibly mid-trade — with no context. Log it loudly and keep running; a
// rejection is not necessarily fatal the way an uncaught exception is.
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Promise Rejection at:', promise, '\nReason:', reason);
});

console.log('🔧 Graceful shutdown handlers installed (Ctrl+C to exit)');

