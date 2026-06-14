// Authentication endpoints for SolSniper backend
import { Express, Request, Response, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma.js';
import { verifyWalletSignature, generateAuthMessage, generateNonce, authenticateUser, optionalAuth } from '../middleware/auth.js';
import nacl from 'tweetnacl';

// ─── Shared nonce store (exported so server.ts wallet-login can consume it) ───
export const pendingNonces = new Map<string, { walletAddress: string; expiresAt: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [nonce, data] of pendingNonces.entries()) {
    if (data.expiresAt < now) pendingNonces.delete(nonce);
  }
}, 60_000);

// Interface for auth requests
interface ConnectRequest {
  walletAddress: string;
  signature: string;
  message: string;
  nonce: string;
  rememberMe?: boolean;
}

interface ConnectResponse {
  success: boolean;
  user: {
    id: string;
    walletAddress: string;
    username?: string;
  };
  token: string;
  expiresAt: string;
}

// Function to setup auth routes on Express app
export function setupAuthRoutes(app: Express): void {

  // POST /api/auth/connect
  // User connects their profile wallet and signs message
  app.post('/api/auth/connect', (async (req: Request, res: Response) => {
    try {
      const { walletAddress, signature, message, nonce, rememberMe = false }: ConnectRequest = req.body;

      // Validation
      if (!walletAddress || !signature || !message || !nonce) {
        return res.status(400).json({
          error: 'Missing required fields',
          code: 'MISSING_FIELDS'
        });
      }

      // Verify the signature
      const isValidSignature = verifyWalletSignature(message, signature, walletAddress);
      if (!isValidSignature) {
        return res.status(400).json({
          error: 'Invalid signature',
          code: 'INVALID_SIGNATURE'
        });
      }

      // Check if message format is correct (basic validation)
      if (!message.includes(walletAddress) || !message.includes(nonce)) {
        return res.status(400).json({
          error: 'Invalid message format',
          code: 'INVALID_MESSAGE'
        });
      }

      // Find or create user
      let user = await prisma.users.findFirst({
        where: {
          walletAddress: walletAddress
        }
      });

      if (!user) {
        // Create new user
        user = await prisma.users.create({
          data: {
            id: generateNonce(), // Generate unique ID for user
            walletAddress: walletAddress
          }
        });
      } else {
        // Update existing user
        user = await prisma.users.update({
          where: { id: user.id },
          data: {
            updatedAt: new Date()
          }
        });
      }

      // For now, we'll use a simple session approach
      // Later we can implement proper session management when the schema is updated

      // Create JWT token
      const tokenPayload = {
        userId: user.id,
        walletAddress: walletAddress,
        sessionId: generateNonce(), // temporary until we have session table
        tier: 'free' // default tier
      };

      const token = jwt.sign(tokenPayload, process.env.JWT_SECRET!, {
        expiresIn: rememberMe ? '7d' : '24h'
      });

      const expiresAt = new Date(Date.now() + (rememberMe ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000));

      // ── Set HttpOnly cookie (browser flow) ──────────────────────────────────
      const isSecure = process.env.NODE_ENV === 'production';
      res.cookie('auth_session', token, {
        httpOnly: true,
        sameSite: isSecure ? 'strict' : 'lax',
        secure: isSecure,
        maxAge: rememberMe ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000,
        path: '/'
      });

      const response: ConnectResponse = {
        success: true,
        user: {
          id: user.id,
          walletAddress: user.walletAddress,
          username: undefined
        },
        token, // kept for Electron / legacy clients
        expiresAt: expiresAt.toISOString()
      };

      res.json(response);

    } catch (error) {
      console.error('Connect error:', error);
      res.status(500).json({
        error: 'Failed to connect wallet',
        code: 'CONNECT_ERROR'
      });
    }
  }) as RequestHandler);

  // POST /api/auth/disconnect
  // Clear the HttpOnly session cookie
  app.post('/api/auth/disconnect', (async (req: Request, res: Response) => {
    try {
      const isSecure = process.env.NODE_ENV === 'production';
      res.clearCookie('auth_session', {
        httpOnly: true,
        sameSite: isSecure ? 'strict' : 'lax',
        path: '/'
      });
      res.json({ success: true });
    } catch (error) {
      console.error('Disconnect error:', error);
      res.status(500).json({
        error: 'Failed to disconnect',
        code: 'DISCONNECT_ERROR'
      });
    }
  }) as RequestHandler);

  // GET /api/auth/verify
  // Session check — returns {valid:true} if authenticated, {valid:false} if not.
  // Uses optionalAuth so unauthenticated requests get 200 {valid:false} instead of 401.
  // (A hard 401 here shows as a red error in devtools on every app load, which is misleading.)
  app.get('/api/auth/verify', optionalAuth as RequestHandler, (async (req: Request, res: Response) => {
    try {
      // optionalAuth sets req.user only if a valid token was found
      if (!req.user) {
        return res.json({ valid: false });
      }

      const cookieToken = (req as any).cookies?.auth_session;
      const bearerToken = req.headers.authorization?.replace('Bearer ', '');
      const token = cookieToken || bearerToken || null;

      // ── Session upgrade: plant cookie when only Bearer is present ──
      if (!cookieToken && bearerToken) {
        const isSecure = process.env.NODE_ENV === 'production';
        res.cookie('auth_session', bearerToken, {
          httpOnly: true,
          sameSite: isSecure ? 'strict' : 'lax',
          secure: isSecure,
          maxAge: 24 * 60 * 60 * 1000,
          path: '/'
        });
      }

      res.json({
        valid: true,
        user: { id: req.user!.id, walletAddress: req.user!.profileWalletAddress },
        token
      });
    } catch (error) {
      console.error('Verify error:', error);
      res.status(500).json({ valid: false, error: 'Verification failed', code: 'VERIFY_ERROR' });
    }
  }) as RequestHandler);

  // GET /api/auth/me
  // Get current user profile — uses authenticateUser middleware (cookie + Bearer)
  app.get('/api/auth/me', authenticateUser as RequestHandler, (async (req: Request, res: Response) => {
    try {
      const user = await prisma.users.findUnique({
        where: { id: req.user!.id },
        include: {
          managed_wallets: {
            select: {
              id: true,
              walletName: true,
              publicKey: true,
              balanceSol: true,
              isActive: true,
              createdAt: true
            }
          }
        }
      });

      if (!user) {
        return res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });
      }

      res.json({
        user: {
          id: user.id,
          walletAddress: user.walletAddress,
          createdAt: user.createdAt,
          managedWallets: user.managed_wallets
        },
        authenticated: true
      });
    } catch (error) {
      console.error('Get profile error:', error);
      res.status(500).json({ error: 'Failed to get profile', code: 'PROFILE_ERROR' });
    }
  }) as RequestHandler);

  // POST /api/auth/nonce
  // Generate a new nonce for message signing — writes to shared pendingNonces store
  app.post('/api/auth/nonce', (async (req: Request, res: Response) => {
    try {
      const { walletAddress } = req.body;

      if (!walletAddress) {
        return res.status(400).json({
          error: 'Wallet address is required',
          code: 'WALLET_ADDRESS_REQUIRED'
        });
      }

      const nonce = Buffer.from(nacl.randomBytes(32)).toString('base64');
      const message = `Welcome to SolSniper!\n\nThis request will not trigger a blockchain transaction or cost any gas fees.\n\nWallet: ${walletAddress}\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}`;
      // Store in shared map so POST /api/auth/wallet-login can verify it
      pendingNonces.set(nonce, { walletAddress, expiresAt: Date.now() + 5 * 60_000 });

      res.json({ nonce, message });
    } catch (error) {
      console.error('Generate nonce error:', error);
      res.status(500).json({ error: 'Failed to generate nonce', code: 'NONCE_ERROR' });
    }
  }) as RequestHandler);

  // ============================================================================
  // ELECTRON PAIRING ENDPOINTS - Sync wallet connection from browser to Electron
  // ============================================================================

  // In-memory store for pairing codes (single-process desktop app)
  const electronPairingCodes = new Map<string, { publicKey: string; token: string; expiresAt: Date }>();

  // POST /api/auth/electron-pair
  // Browser sends wallet info with pairing code
  app.post('/api/auth/electron-pair', (async (req: Request, res: Response) => {
    try {
      const { publicKey, pairingCode } = req.body;

      if (!publicKey || !pairingCode) {
        return res.status(400).json({
          error: 'Missing required fields',
          code: 'MISSING_FIELDS'
        });
      }

      console.log(`🔗 Electron pairing request for ${publicKey.slice(0, 8)}... with code ${pairingCode}`);

      // Find or create user
      let user = await prisma.users.findFirst({
        where: { walletAddress: publicKey }
      });

      if (!user) {
        user = await prisma.users.create({
          data: {
            id: generateNonce(),
            walletAddress: publicKey
          }
        });
      }

      // Create JWT token for this user
      const tokenPayload = {
        userId: user.id,
        walletAddress: publicKey,
        sessionId: generateNonce(),
        tier: 'free',
        source: 'electron-pair'
      };

      const token = jwt.sign(tokenPayload, process.env.JWT_SECRET!, {
        expiresIn: '7d'
      });

      // Store the pairing code with the token (expires in 5 minutes)
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
      electronPairingCodes.set(pairingCode.toUpperCase(), {
        publicKey,
        token,
        expiresAt
      });

      // Cleanup expired codes
      for (const [code, data] of electronPairingCodes.entries()) {
        if (data.expiresAt < new Date()) {
          electronPairingCodes.delete(code);
        }
      }

      console.log(`✅ Pairing code ${pairingCode} stored (expires in 5 min)`);

      res.json({
        success: true,
        message: 'Pairing code registered. Enter this code in the Electron app.'
      });

    } catch (error) {
      console.error('Electron pair error:', error);
      res.status(500).json({
        error: 'Failed to register pairing code',
        code: 'PAIR_ERROR'
      });
    }
  }) as RequestHandler);

  // POST /api/auth/electron-claim
  // Electron app claims the token using the pairing code
  app.post('/api/auth/electron-claim', (async (req: Request, res: Response) => {
    try {
      const { pairingCode } = req.body;

      if (!pairingCode) {
        return res.status(400).json({
          error: 'Pairing code is required',
          code: 'MISSING_CODE'
        });
      }

      const normalizedCode = pairingCode.toUpperCase().trim();
      const pairingData = electronPairingCodes.get(normalizedCode);

      if (!pairingData) {
        return res.status(404).json({
          error: 'Invalid or expired pairing code',
          code: 'INVALID_CODE'
        });
      }

      if (pairingData.expiresAt < new Date()) {
        electronPairingCodes.delete(normalizedCode);
        return res.status(410).json({
          error: 'Pairing code has expired',
          code: 'CODE_EXPIRED'
        });
      }

      // Get user info
      const user = await prisma.users.findFirst({
        where: { walletAddress: pairingData.publicKey }
      });

      // Remove the used pairing code
      electronPairingCodes.delete(normalizedCode);

      console.log(`✅ Electron claimed pairing code ${normalizedCode} for ${pairingData.publicKey.slice(0, 8)}...`);

      res.json({
        success: true,
        token: pairingData.token,
        user: user ? {
          id: user.id,
          walletAddress: user.walletAddress
        } : null,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      });

    } catch (error) {
      console.error('Electron claim error:', error);
      res.status(500).json({
        error: 'Failed to claim pairing code',
        code: 'CLAIM_ERROR'
      });
    }
  }) as RequestHandler);

  // GET /api/auth/electron-check/:code
  // Check if a pairing code is valid (for polling)
  app.get('/api/auth/electron-check/:code', (async (req: Request, res: Response) => {
    try {
      const { code } = req.params;
      const normalizedCode = code.toUpperCase().trim();
      const pairingData = electronPairingCodes.get(normalizedCode);

      if (!pairingData || pairingData.expiresAt < new Date()) {
        return res.json({ valid: false });
      }

      res.json({
        valid: true,
        walletAddress: pairingData.publicKey.slice(0, 4) + '...' + pairingData.publicKey.slice(-4)
      });

    } catch (error) {
      res.json({ valid: false });
    }
  }) as RequestHandler);

  // End of function
}
