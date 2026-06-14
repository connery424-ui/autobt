// Authentication middleware for SolSniper backend - OPTIMIZED VERSION
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma.js';
import { PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

// Note: req.cookies is typed as 'any' by express-serve-static-core when cookie-parser is used

// Simple in-memory cache for user data (5 minute TTL)
interface CachedUser {
  user: any;
  timestamp: number;
}

const userCache = new Map<string, CachedUser>();
const CACHE_TTL = 2 * 60 * 1000; // 2 minutes for faster testing

// Optional callback fired after successful auth — used by server.ts to set
// the sniper sign context without creating a circular dependency.
let _authSuccessHook: ((userId: string) => void) | null = null;
export const setAuthSuccessHook = (fn: (userId: string) => void) => { _authSuccessHook = fn; };

// Function to get user from cache or database
const getCachedUser = async (userId: string, walletAddress: string) => {
  const now = Date.now();
  const cached = userCache.get(userId);

  // Return cached user if still valid
  if (cached && (now - cached.timestamp) < CACHE_TTL) {
    console.log('💾 Using cached user data for:', userId, '(age:', Math.round((now - cached.timestamp) / 1000), 'seconds)');
    return cached.user;
  }

  // Fetch from database - use correct lowercase 'users' model
  console.log('🔍 Checking if user exists in database:', userId);
  let user = await prisma.users.findUnique({
    where: { id: userId }
  });

  if (!user) {
    console.log('👤 User not found, creating new user:', userId);
    try {
      user = await prisma.users.create({
        data: {
          id: userId,
          walletAddress: walletAddress
        }
      });
      console.log('✅ User created successfully:', userId);
    } catch (userError) {
      console.error('❌ Error creating user:', userError);
      throw new Error('Failed to create user');
    }
  } else {
    console.log('✅ User already exists:', userId);
  }

  // Cache the user data
  console.log('💾 Caching user data for:', userId);
  userCache.set(userId, { user, timestamp: now });

  return user;
};

// Extend Request interface to include user
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        profileWalletAddress: string;
        username?: string;
        subscriptionTier: string;
      };
      sessionId?: string;
    }
  }
}

// JWT payload interface
interface JWTPayload {
  userId: string;
  walletAddress: string;
  sessionId: string;
  iat: number;
  exp: number;
  tier: string;
}

// Authentication middleware — checks HttpOnly cookie first, then Bearer header (Electron)
export const authenticateUser = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // 1. Try HttpOnly cookie (browser flow)
    let token: string | undefined = req.cookies?.auth_session;

    // 2. Fall back to Authorization: Bearer header (Electron pairing flow)
    if (!token) {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
      }
    }

    if (!token) {
      return res.status(401).json({
        error: 'No authentication token provided',
        code: 'AUTH_TOKEN_MISSING'
      });
    }

    // SECURITY: Removed token prefix logging - could expose partial token in logs

    if (!process.env.JWT_SECRET) {
      return res.status(500).json({
        error: 'JWT secret not configured',
        code: 'JWT_SECRET_MISSING'
      });
    }

    let decoded: JWTPayload;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET) as JWTPayload;
    } catch (jwtError) {
      console.error('❌ JWT verification failed:', jwtError);
      return res.status(401).json({
        error: 'Invalid or expired token',
        code: 'INVALID_TOKEN'
      });
    }

    const user = await getCachedUser(decoded.userId, decoded.walletAddress);

    req.user = {
      id: user.id,
      profileWalletAddress: user.walletAddress,
      subscriptionTier: decoded.tier || 'free'
    };
    req.sessionId = decoded.sessionId;

    console.log('✅ JWT auth success for user:', user.id);
    // Fire the hook non-blocking so auth is never delayed
    if (_authSuccessHook) _authSuccessHook(user.id);
    next();

  } catch (error) {
    console.error('❌ Auth middleware error:', error);
    return res.status(500).json({
      error: 'Authentication server error',
      code: 'AUTH_SERVER_ERROR'
    });
  }
};

// Other authentication functions...
// SECURITY FIX: Removed generateAuthToken - base64 tokens are no longer supported




// Utility function to verify wallet signature
export const verifyWalletSignature = (
  message: string,
  signature: string,
  publicKey: string
): boolean => {
  try {
    const messageBytes = new TextEncoder().encode(message);
    const signatureBytes = bs58.decode(signature);
    const publicKeyBytes = new PublicKey(publicKey).toBytes();

    return nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);
  } catch (error) {
    console.error('Signature verification error:', error);
    return false;
  }
};

// Generate authentication message
export const generateAuthMessage = (walletAddress: string, nonce: string): string => {
  return `Welcome to SolSniper!

This request will not trigger a blockchain transaction or cost any gas fees.

Your authentication status will remain active for 24 hours.

Wallet address: ${walletAddress}
Nonce: ${nonce}
Timestamp: ${new Date().toISOString()}`;
};

// Generate secure nonce
export const generateNonce = (): string => {
  return Buffer.from(nacl.randomBytes(32)).toString('base64');
};

// Optional auth middleware — checks cookie OR Bearer header, passes through if neither present
export const optionalAuth = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Check if there's anything to authenticate with (cookie or Bearer header)
    const hasCookie = !!(req.cookies?.auth_session);
    const hasBearer = req.headers.authorization?.startsWith('Bearer ');

    if (!hasCookie && !hasBearer) {
      return next(); // No credentials at all — proceed unauthenticated
    }

    // Delegate to authenticateUser which checks cookie first, then Bearer
    await authenticateUser(req, res, next);
  } catch (error) {
    // If auth fails, continue without authentication
    console.warn('Optional auth failed:', error);
    next();
  }
};

// Clean up expired cache entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [userId, cached] of userCache.entries()) {
    if (now - cached.timestamp > CACHE_TTL) {
      userCache.delete(userId);
      console.log('🧹 Cleaned up expired cache entry for user:', userId);
    }
  }
}, CACHE_TTL); // Run cleanup every 5 minutes

// SECURITY FIX: Admin authorization middleware
// Checks if user has admin access based on subscription tier
export const isAdminUser = (user: any): boolean => {
  // Users with 'premium' or higher subscription tier have admin access
  // In production, you might want a dedicated isAdmin field in the database
  const adminTiers = ['premium', 'admin', 'owner'];
  return adminTiers.includes(user?.subscriptionTier || '');
};

// Admin check middleware - returns 403 if user is not admin
export const requireAdmin = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // First ensure user is authenticated
    if (!req.user || !req.user.id) {
      return res.status(401).json({
        error: 'Authentication required',
        code: 'AUTH_REQUIRED'
      });
    }

    // Check if user has admin access
    if (!isAdminUser(req.user)) {
      console.warn(`🚫 Non-admin user attempted admin access: ${req.user.id} (tier: ${req.user.subscriptionTier})`);
      return res.status(403).json({
        error: 'Admin access required',
        code: 'FORBIDDEN'
      });
    }

    console.log(`✅ Admin access granted to user: ${req.user.id} (tier: ${req.user.subscriptionTier})`);
    next();
  } catch (error) {
    console.error('❌ Admin check middleware error:', error);
    return res.status(500).json({
      error: 'Admin check failed',
      code: 'ADMIN_CHECK_ERROR'
    });
  }
};
