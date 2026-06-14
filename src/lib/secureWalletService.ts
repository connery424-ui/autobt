import { Keypair as SolanaKeypair } from '@solana/web3.js';
import * as crypto from 'crypto';
import { prisma } from './prisma';
import { PerformanceMonitor } from './performanceMonitor';
import bs58 from 'bs58';

export class SecureWalletService {
  private static readonly ALGORITHM = 'aes-256-gcm';
  private static readonly KEY_LENGTH = 32;
  private static readonly PBKDF2_ITERATIONS = 100000; // 100k iterations
  private static readonly IV_LENGTH = 12; // 96-bit IV for GCM
  private static readonly TAG_LENGTH = 16; // 128-bit auth tag
  private static readonly MAX_WALLETS_PER_USER = 100; // Security limit
  private static readonly OPERATION_TIMEOUT = 30000; // 30 seconds

  private masterKey: Buffer;
  private operationCounts: Map<string, { count: number; lastReset: number }> = new Map();
  // In-memory signing-keypair cache. Avoids re-running PBKDF2 (100k iterations,
  // ~10-50ms) on every signing call — the per-trade latency that matters for
  // 0-block sniping. Keyed by `${userId}:${walletId}`. Invalidated whenever the
  // user's wallets change (create/import/delete) via invalidateUserWalletCache.
  // Acceptable here: single-user, secured Windows host; the decrypted key is
  // already resident in memory during a trading session regardless.
  private keypairCache: Map<string, any> = new Map();

  constructor() {
    const envKey = process.env.WALLET_ENCRYPTION_KEY;
    if (!envKey) {
      throw new Error('WALLET_ENCRYPTION_KEY must be set in .env file');
    }

    // Validate key format and length
    if (!/^[0-9a-fA-F]+$/.test(envKey)) {
      throw new Error('WALLET_ENCRYPTION_KEY must be a valid hex string');
    }

    const keyBuffer = Buffer.from(envKey, 'hex');
    if (keyBuffer.length !== SecureWalletService.KEY_LENGTH) {
      throw new Error(`WALLET_ENCRYPTION_KEY must be exactly ${SecureWalletService.KEY_LENGTH} bytes (${SecureWalletService.KEY_LENGTH * 2} hex characters)`);
    }

    this.masterKey = keyBuffer;

    // Setup cleanup on process exit
    process.on('exit', () => this.cleanup());
    process.on('SIGINT', () => this.cleanup());
    process.on('SIGTERM', () => this.cleanup());
  }

  /**
   * Cleanup sensitive data from memory
   */
  private cleanup(): void {
    if (this.masterKey) {
      this.masterKey.fill(0);
    }
    this.operationCounts.clear();
  }

  /**
   * Rate limiting for wallet operations
   */
  private checkRateLimit(userId: string, operation: string): void {
    const key = `${userId}:${operation}`;
    const now = Date.now();
    const resetInterval = 3600000; // 1 hour
    const maxOperations = operation === 'create' ? 10 : 100; // 10 wallet creations per hour, 100 other ops

    let userOps = this.operationCounts.get(key);

    if (!userOps || now - userOps.lastReset > resetInterval) {
      userOps = { count: 0, lastReset: now };
      this.operationCounts.set(key, userOps);
    }

    if (userOps.count >= maxOperations) {
      throw new Error(`Rate limit exceeded for ${operation}. Try again later.`);
    }

    userOps.count++;
  }

  /**
   * Secure input validation and sanitization
   */
  private validateInputs(userId: string, walletName?: string): void {
    if (!userId || typeof userId !== 'string' || userId.length < 1 || userId.length > 255) {
      throw new Error('Invalid user ID');
    }

    if (walletName !== undefined) {
      if (typeof walletName !== 'string' || walletName.length < 1 || walletName.length > 100) {
        throw new Error('Wallet name must be between 1 and 100 characters');
      }

      // Prevent XSS and injection attempts
      if (/<script|javascript:|data:/i.test(walletName)) {
        throw new Error('Invalid characters in wallet name');
      }
    }
  }

  /**
   * Derive user-specific encryption key using PBKDF2 with per-wallet salt
   */
  private deriveUserKey(userId: string, context: string = 'wallet', walletSalt?: string): Buffer {
    // Create deterministic salt from userId, context, and optional wallet-specific salt
    const saltInput = walletSalt
      ? `${userId}:${context}:${walletSalt}:solsniper:v2`
      : `${userId}:${context}:solsniper:v2`;

    const salt = crypto.createHash('sha256').update(saltInput).digest();

    // Derive key using PBKDF2
    const derivedKey = crypto.pbkdf2Sync(
      this.masterKey,
      salt,
      SecureWalletService.PBKDF2_ITERATIONS,
      SecureWalletService.KEY_LENGTH,
      'sha256'
    );

    return derivedKey;
  }

  /**
   * Generate cryptographically secure wallet-specific salt
   */
  private generateWalletSalt(): string {
    return crypto.randomBytes(16).toString('hex');
  }

  /**
   * Secure memory wiping for sensitive buffers
   */
  private secureWipe(buffer: Buffer | Uint8Array): void {
    if (buffer instanceof Buffer) {
      buffer.fill(0);
    } else if (buffer instanceof Uint8Array) {
      buffer.fill(0);
    }
  }

  /**
   * Encrypt private key using AES-256-GCM with user-derived key
   */
  private encryptPrivateKey(privateKey: Uint8Array, userId: string, walletSalt: string): string {
    let userKey: Buffer | undefined;
    let iv: Buffer | undefined;

    try {
      userKey = this.deriveUserKey(userId, 'wallet', walletSalt);
      iv = crypto.randomBytes(SecureWalletService.IV_LENGTH);
      const cipher = crypto.createCipheriv(SecureWalletService.ALGORITHM, userKey, iv);

      let encrypted = cipher.update(Buffer.from(privateKey));
      encrypted = Buffer.concat([encrypted, cipher.final()]);

      const authTag = cipher.getAuthTag();

      // Combine IV + AuthTag + Encrypted data
      const combined = Buffer.concat([iv, authTag, encrypted]);
      const result = combined.toString('base64');

      return result;
    } finally {
      // Secure cleanup
      if (userKey) this.secureWipe(userKey);
      if (iv) this.secureWipe(iv);
      this.secureWipe(Buffer.from(privateKey));
    }
  }

  /**
   * Decrypt private key using user-derived key - Memory Safe Version
   */
  private decryptPrivateKey(encryptedData: string, userId: string, walletSalt: string): Uint8Array {
    // Create isolated scope to prevent memory interference
    return this.performDecryptionInIsolation(encryptedData, userId, walletSalt);
  }

  /**
   * Perform decryption in isolated scope to prevent memory corruption
   */
  private performDecryptionInIsolation(encryptedData: string, userId: string, walletSalt: string): Uint8Array {
    // Single attempt - let server-level retry handle multiple attempts
    try {
      return this.attemptDecryption(encryptedData, userId, walletSalt);
    } catch (error) {
      console.error(`❌ Decryption failed:`, (error as Error).message);
      throw error; // Let server-level retry handle this
    }
  }

  /**
   * Single decryption attempt with proper cleanup
   */
  private attemptDecryption(encryptedData: string, userId: string, walletSalt: string): Uint8Array {
    let userKey: Buffer | undefined;
    let combined: Buffer | undefined;
    let decrypted: Buffer | undefined;
    let iv: Buffer | undefined;
    let authTag: Buffer | undefined;
    let encrypted: Buffer | undefined;

    try {
      // Step 1: Derive user key
      userKey = this.deriveUserKey(userId, 'wallet', walletSalt);

      // Step 2: Parse encrypted data
      combined = Buffer.from(encryptedData, 'base64');

      if (combined.length < SecureWalletService.IV_LENGTH + SecureWalletService.TAG_LENGTH) {
        throw new Error(`Invalid encrypted data format - too short: ${combined.length}`);
      }

      // Step 3: Extract components with proper copying to prevent memory issues
      iv = Buffer.alloc(SecureWalletService.IV_LENGTH);
      combined.copy(iv, 0, 0, SecureWalletService.IV_LENGTH);

      authTag = Buffer.alloc(SecureWalletService.TAG_LENGTH);
      combined.copy(authTag, 0, SecureWalletService.IV_LENGTH, SecureWalletService.IV_LENGTH + SecureWalletService.TAG_LENGTH);

      encrypted = Buffer.alloc(combined.length - SecureWalletService.IV_LENGTH - SecureWalletService.TAG_LENGTH);
      combined.copy(encrypted, 0, SecureWalletService.IV_LENGTH + SecureWalletService.TAG_LENGTH);

      // P1 FIX: Removed verbose console.log statements from decrypt path
      // These leaked sensitive operation details (buffer lengths, component sizes)

      // Step 4: Create fresh decipher instance
      const decipher = crypto.createDecipheriv(SecureWalletService.ALGORITHM, userKey, iv);
      decipher.setAuthTag(authTag);

      // Step 5: Decrypt with error handling
      let decryptedPart1: Buffer;
      let decryptedPart2: Buffer;

      try {
        decryptedPart1 = decipher.update(encrypted);
      } catch (updateError) {
        throw new Error(`Decipher update failed: ${(updateError as Error).message}`);
      }

      try {
        decryptedPart2 = decipher.final();
      } catch (finalError) {
        throw new Error(`Decipher final failed: ${(finalError as Error).message}`);
      }

      decrypted = Buffer.concat([decryptedPart1, decryptedPart2]);

      // Return copy to prevent reference issues
      const result = new Uint8Array(decrypted.length);
      result.set(decrypted);
      return result;

    } finally {
      // Comprehensive cleanup
      if (userKey) { this.secureWipe(userKey); userKey = undefined; }
      if (combined) { this.secureWipe(combined); combined = undefined; }
      if (decrypted) { this.secureWipe(decrypted); decrypted = undefined; }
      if (iv) { this.secureWipe(iv); iv = undefined; }
      if (authTag) { this.secureWipe(authTag); authTag = undefined; }
      if (encrypted) { this.secureWipe(encrypted); encrypted = undefined; }
    }
  }

  /**
   * Non-blocking sleep function for retry delays
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Create a new secure wallet
   */
  async createWallet(userId: string, walletName: string) {
    this.validateInputs(userId, walletName);
    this.checkRateLimit(userId, 'create');

    try {
      // Ensure user exists in users table
      const user = await prisma.users.findUnique({
        where: { id: userId }
      });

      if (!user) {
        // Create the user if they don't exist
        await prisma.users.create({
          data: {
            id: userId,
            walletAddress: userId, // Using userId as wallet address for auth
            createdAt: new Date(),
            updatedAt: new Date(),
          }
        });
        console.log(`✅ Created user record for ${userId}`);
      }

      // Check wallet count limit
      const existingWallets = await prisma.managed_wallets.count({
        where: { userId }
      });

      if (existingWallets >= SecureWalletService.MAX_WALLETS_PER_USER) {
        throw new Error(`Maximum wallet limit (${SecureWalletService.MAX_WALLETS_PER_USER}) reached`);
      }

      // Generate new keypair and wallet-specific salt
      const keypair = SolanaKeypair.generate();
      const publicKey = keypair.publicKey.toBase58();
      const walletSalt = this.generateWalletSalt();

      // Encrypt the private key using user-derived key with wallet salt
      const encryptedPrivateKey = this.encryptPrivateKey(keypair.secretKey, userId, walletSalt);

      // Save to database (Supabase)
      const wallet = await prisma.managed_wallets.create({
        data: {
          id: crypto.randomUUID(),
          userId,
          walletName,
          publicKey,
          encryptedPrivateKey,
          encryption_salt: walletSalt,
          balanceSol: 0.0,
          balanceTokens: '{}',
          isActive: true,
          transactionCount: 0,
        },
      });

      console.log(`✅ Created secure wallet "${walletName}" for user ${userId}`);
      console.log(`📍 Public Key: ${publicKey}`);
      console.log(`🔐 Private key encrypted with AES-256-GCM and stored in database`);

      // Invalidate user wallet cache
      this.invalidateUserWalletCache(userId);

      return {
        id: wallet.id,
        walletName: wallet.walletName,
        publicKey: wallet.publicKey,
        balanceSol: Number(wallet.balanceSol),
        isActive: wallet.isActive,
        createdAt: wallet.createdAt,
      };
    } catch (error) {
      console.error('❌ Error creating secure wallet:', error);
      throw new Error('Failed to create wallet');
    }
  }

  /**
   * Create multiple wallets securely with batch processing
   */
  async createWalletsBatch(userId: string, walletNames: string[], maxBatchSize: number = 10) {
    this.validateInputs(userId);
    this.checkRateLimit(userId, 'batch-create');

    if (!Array.isArray(walletNames) || walletNames.length === 0) {
      throw new Error('Wallet names array is required');
    }

    if (walletNames.length > maxBatchSize) {
      throw new Error(`Batch size cannot exceed ${maxBatchSize} wallets`);
    }

    // Validate all wallet names
    walletNames.forEach(name => this.validateInputs(userId, name));

    // Check total wallet limit
    const existingWallets = await prisma.managed_wallets.count({
      where: { userId }
    });

    if (existingWallets + walletNames.length > SecureWalletService.MAX_WALLETS_PER_USER) {
      throw new Error(`Would exceed maximum wallet limit (${SecureWalletService.MAX_WALLETS_PER_USER})`);
    }

    const results = [];
    const errors = [];

    for (const walletName of walletNames) {
      try {
        const wallet = await this.createWallet(userId, walletName);
        results.push(wallet);
      } catch (error) {
        console.error(`Failed to create wallet "${walletName}":`, error);
        errors.push({ walletName, error: error instanceof Error ? error.message : 'Unknown error' });
      }
    }

    // Invalidate user wallet cache after batch creation
    this.invalidateUserWalletCache(userId);

    return {
      successful: results,
      failed: errors,
      totalCreated: results.length,
      totalFailed: errors.length
    };
  }

  // Cache for wallet data (short-lived cache to reduce DB hits)
  private walletCache = new Map<string, { data: any; timestamp: number }>();
  private readonly CACHE_TTL = 30000; // 30 seconds cache

  /**
   * Get user wallets (without private keys) with optimized caching
   */
  async getUserWallets(userId: string, bypassCache = false) {
    const stopTimer = PerformanceMonitor.startTimer('getUserWallets');

    try {
      // Check cache first (unless bypassed)
      const cacheKey = `wallets:${userId}`;
      if (!bypassCache) {
        const cached = this.walletCache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp) < this.CACHE_TTL) {
          console.log(`💨 Cache hit for user ${userId} wallets`);
          stopTimer({ cached: true, count: cached.data.length });
          return cached.data;
        }
      }

      // Optimized query - only select essential fields for listing
      const start = Date.now();
      const wallets = await prisma.managed_wallets.findMany({
        where: { userId },
        select: {
          id: true,
          walletName: true,
          publicKey: true,
          balanceSol: true,
          isActive: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        // Add take limit to prevent massive queries
        take: 100, // Max 100 wallets per user for performance
      });

      const queryTime = Date.now() - start;
      console.log(`🔍 DB query took ${queryTime}ms for ${wallets.length} wallets`);

      const result = wallets.map(wallet => ({
        id: wallet.id,
        walletName: wallet.walletName,
        publicKey: wallet.publicKey,
        balanceSol: Number(wallet.balanceSol),
        balanceTokens: {}, // Default empty for performance
        isActive: wallet.isActive,
        createdAt: wallet.createdAt,
        lastUsedAt: null, // Not fetched for performance
        transactionCount: 0, // Not fetched for performance
      }));

      // Cache the result
      this.walletCache.set(cacheKey, {
        data: result,
        timestamp: Date.now()
      });

      stopTimer({ cached: false, count: result.length, queryTime });
      return result;
    } catch (error) {
      console.error('❌ Error fetching user wallets:', error);
      stopTimer({ error: true });
      throw new Error('Failed to fetch wallets');
    }
  }

  /**
   * Get user wallets with ultra-aggressive performance optimization
   */
  async getUserWalletsUltraFast(userId: string, bypassCache = false) {
    const stopTimer = PerformanceMonitor.startTimer('getUserWalletsUltraFast');

    try {
      // Check cache first (unless bypassed)
      const cacheKey = `wallets:${userId}`;
      if (!bypassCache) {
        const cached = this.walletCache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp) < this.CACHE_TTL) {
          console.log(`💨 Cache hit for user ${userId} wallets`);
          stopTimer({ cached: true, count: cached.data.length });
          return cached.data;
        }
      }

      // Ultra-optimized query - minimal fields only
      const start = Date.now();
      const wallets = await prisma.$queryRaw`
        SELECT 
          id, 
          "walletName", 
          "publicKey", 
          "balanceSol",
          "isActive", 
          "createdAt",
          "wallet_type"
        FROM managed_wallets 
        WHERE "userId" = ${userId}
        ORDER BY "createdAt" DESC 
        LIMIT 50
      `;

      const queryTime = Date.now() - start;
      console.log(`⚡ Raw query took ${queryTime}ms for ${(wallets as any[]).length} wallets`);

      const result = (wallets as any[]).map(wallet => ({
        id: wallet.id,
        walletName: wallet.walletName,
        publicKey: wallet.publicKey,
        balanceSol: Number(wallet.balanceSol),
        balanceTokens: {}, // Default empty for performance
        isActive: wallet.isActive,
        createdAt: wallet.createdAt,
        lastUsedAt: null, // Not fetched for performance
        transactionCount: 0, // Not fetched for performance
        wallet_type: wallet.wallet_type || 'sniping',
      }));

      // Cache the result with longer TTL for ultra-fast subsequent loads
      this.walletCache.set(cacheKey, {
        data: result,
        timestamp: Date.now()
      });

      stopTimer({ cached: false, count: result.length, queryTime });
      return result;
    } catch (error) {
      console.error('❌ Error fetching user wallets with raw query:', error);
      // Fallback to regular method
      return this.getUserWallets(userId, bypassCache);
    }
  }

  /**
   * Invalidate cache for user wallets (call after wallet operations)
   */
  invalidateUserWalletCache(userId: string) {
    const cacheKey = `wallets:${userId}`;
    this.walletCache.delete(cacheKey);
    // Also drop any cached signing keypairs for this user so a deleted/rotated
    // wallet can't keep signing from a stale in-memory key.
    const prefix = `${userId}:`;
    for (const key of this.keypairCache.keys()) {
      if (key.startsWith(prefix)) this.keypairCache.delete(key);
    }
    console.log(`🗑️ Invalidated wallet cache for user ${userId}`);
  }

  /**
   * Get keypair for transaction signing
   * ⚠️ CRITICAL: Only use for transaction signing - never expose private keys
   */
  async getKeypairForSigning(walletId: string, userId: string): Promise<any> {
    this.validateInputs(userId);
    this.checkRateLimit(userId, 'signing');

    // Fast path: return the cached keypair, skipping DB read + PBKDF2 + AES.
    // Rate limiting above still applies so caching can't be used to bypass it.
    const cacheKey = `${userId}:${walletId}`;
    const cached = this.keypairCache.get(cacheKey);
    if (cached) return cached;

    let privateKeyBytes: Uint8Array | undefined;

    try {
      const wallet = await prisma.managed_wallets.findFirst({
        where: {
          id: walletId,
          userId: userId
        },
        select: {
          encryptedPrivateKey: true,
          encryption_salt: true,
        },
      });

      if (!wallet || !wallet.encryptedPrivateKey || !wallet.encryption_salt) {
        throw new Error('Wallet not found or missing encryption data');
      }

      // Decrypt private key using user-derived key with wallet salt
      privateKeyBytes = this.decryptPrivateKey(wallet.encryptedPrivateKey, userId, wallet.encryption_salt);

      // ⚠️ Create keypair from a COPY — Keypair.fromSecretKey shares the buffer
      // reference, so secureWipe(privateKeyBytes) in finally would zero the keypair
      // secretKey too, causing 'signature verification failed' on tx.sign().
      const keypair = SolanaKeypair.fromSecretKey(Uint8Array.from(privateKeyBytes));

      // Cache for subsequent signings this session (PBKDF2 runs once per wallet).
      this.keypairCache.set(cacheKey, keypair);

      return keypair;
    } catch (error) {
      console.error('❌ Error getting keypair for signing:', error);
      throw new Error('Failed to decrypt wallet for signing');
    } finally {
      // Secure cleanup
      if (privateKeyBytes) {
        this.secureWipe(privateKeyBytes);
      }
    }
  }

  /**
   * Rotate encryption for a wallet (re-encrypt with new salt)
   */
  async rotateWalletEncryption(walletId: string, userId: string) {
    this.validateInputs(userId);
    this.checkRateLimit(userId, 'rotation');

    let oldPrivateKeyBytes: Uint8Array | undefined;
    let newSalt: string | undefined;

    try {
      // Get current wallet data
      const wallet = await prisma.managed_wallets.findFirst({
        where: { id: walletId, userId },
        select: {
          encryptedPrivateKey: true,
          encryption_salt: true,
        },
      });

      if (!wallet || !wallet.encryptedPrivateKey || !wallet.encryption_salt) {
        throw new Error('Wallet not found or missing encryption data');
      }

      // Decrypt with old salt
      oldPrivateKeyBytes = this.decryptPrivateKey(wallet.encryptedPrivateKey, userId, wallet.encryption_salt);

      // Generate new salt and re-encrypt
      newSalt = this.generateWalletSalt();
      const newEncryptedPrivateKey = this.encryptPrivateKey(oldPrivateKeyBytes, userId, newSalt);

      // Update database
      await prisma.managed_wallets.updateMany({
        where: { id: walletId, userId },
        data: {
          encryptedPrivateKey: newEncryptedPrivateKey,
          encryption_salt: newSalt,
          lastUsedAt: new Date(),
        },
      });

      console.log(`✅ Rotated encryption for wallet ${walletId}`);
      return { success: true, message: 'Wallet encryption rotated successfully' };
    } catch (error) {
      console.error('❌ Error rotating wallet encryption:', error);
      throw new Error('Failed to rotate wallet encryption');
    } finally {
      // Secure cleanup
      if (oldPrivateKeyBytes) this.secureWipe(oldPrivateKeyBytes);
    }
  }

  /**
   * Security audit for user wallets
   */
  async auditUserWallets(userId: string) {
    this.validateInputs(userId);

    try {
      const wallets = await prisma.managed_wallets.findMany({
        where: { userId },
        select: {
          id: true,
          walletName: true,
          publicKey: true,
          encryption_salt: true,
          is_encrypted: true,
          createdAt: true,
          lastUsedAt: true,
          transactionCount: true,
        },
      });

      const audit = {
        totalWallets: wallets.length,
        encryptedWallets: wallets.filter(w => w.is_encrypted).length,
        unencryptedWallets: wallets.filter(w => !w.is_encrypted).length,
        walletsWithSalt: wallets.filter(w => w.encryption_salt).length,
        walletsWithoutSalt: wallets.filter(w => !w.encryption_salt).length,
        oldestWallet: wallets.length > 0 ? Math.min(...wallets.map(w => w.createdAt.getTime())) : null,
        newestWallet: wallets.length > 0 ? Math.max(...wallets.map(w => w.createdAt.getTime())) : null,
        activeWallets: wallets.filter(w => w.lastUsedAt && w.lastUsedAt > new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)).length,
        securityScore: this.calculateSecurityScore(wallets),
      };

      return audit;
    } catch (error) {
      console.error('❌ Error auditing user wallets:', error);
      throw new Error('Failed to audit wallets');
    }
  }

  /**
   * Calculate security score for wallet collection
   */
  private calculateSecurityScore(wallets: any[]): number {
    if (wallets.length === 0) return 100;

    let score = 100;

    // Deduct points for unencrypted wallets
    const unencryptedCount = wallets.filter(w => !w.is_encrypted).length;
    score -= (unencryptedCount / wallets.length) * 40;

    // Deduct points for wallets without salt
    const noSaltCount = wallets.filter(w => !w.encryption_salt).length;
    score -= (noSaltCount / wallets.length) * 30;

    // Deduct points for very old wallets (>1 year without rotation)
    const oldWallets = wallets.filter(w => {
      const age = Date.now() - w.createdAt.getTime();
      return age > 365 * 24 * 60 * 60 * 1000; // 1 year
    }).length;
    score -= (oldWallets / wallets.length) * 20;

    // Deduct points for too many wallets
    if (wallets.length > SecureWalletService.MAX_WALLETS_PER_USER * 0.8) {
      score -= 10;
    }

    return Math.max(0, Math.round(score));
  }

  /**
   * Secure deletion of wallet
   */
  async deleteWallet(walletId: string, userId: string, confirmationPhrase: string) {
    this.validateInputs(userId);
    this.checkRateLimit(userId, 'delete');

    if (confirmationPhrase !== 'DELETE_WALLET_PERMANENTLY') {
      throw new Error('Invalid confirmation phrase');
    }

    try {
      const result = await prisma.managed_wallets.deleteMany({
        where: { id: walletId, userId },
      });

      if (result.count === 0) {
        throw new Error('Wallet not found or not owned by user');
      }

      console.log(`✅ Securely deleted wallet ${walletId} for user ${userId}`);

      // Invalidate user wallet cache
      this.invalidateUserWalletCache(userId);

      return { success: true, message: 'Wallet deleted permanently' };
    } catch (error) {
      console.error('❌ Error deleting wallet:', error);
      throw new Error('Failed to delete wallet');
    }
  }

  /**
   * Update wallet balance
   */
  async updateWalletBalance(walletId: string, userId: string, balanceSol: number) {
    try {
      await prisma.managed_wallets.updateMany({
        where: {
          id: walletId,
          userId: userId
        },
        data: {
          balanceSol: balanceSol,
          lastUsedAt: new Date(),
        },
      });
    } catch (error) {
      console.error('❌ Error updating wallet balance:', error);
      throw new Error('Failed to update wallet balance');
    }
  }

  /**
   * Set active wallet for user (atomic transaction)
   */
  async setActiveWallet(walletId: string, userId: string) {
    try {
      // P1 FIX: Use $transaction for atomicity - prevents race condition where
      // user could have no active wallet if second update fails
      await prisma.$transaction([
        // First, deactivate all wallets for user
        prisma.managed_wallets.updateMany({
          where: { userId },
          data: { isActive: false },
        }),
        // Then activate the selected wallet
        prisma.managed_wallets.updateMany({
          where: {
            id: walletId,
            userId: userId
          },
          data: {
            isActive: true,
            lastUsedAt: new Date(),
          },
        }),
      ]);

      console.log(`✅ Set wallet ${walletId} as active for user ${userId}`);
    } catch (error) {
      console.error('❌ Error setting active wallet:', error);
      throw new Error('Failed to set active wallet');
    }
  }

  /**
   * Get a single wallet by ID (without private key)
   */
  async getWallet(walletId: string, userId?: string) {
    try {
      const where = userId ? { id: walletId, userId } : { id: walletId };

      const wallet = await prisma.managed_wallets.findFirst({
        where,
        select: {
          id: true,
          userId: true,
          walletName: true,
          publicKey: true,
          balanceSol: true,
          balanceTokens: true,
          isActive: true,
          createdAt: true,
          lastUsedAt: true,
          transactionCount: true,
        },
      });

      if (!wallet) {
        return null;
      }

      return {
        id: wallet.id,
        userId: wallet.userId,
        walletName: wallet.walletName,
        publicKey: wallet.publicKey,
        balanceSol: Number(wallet.balanceSol),
        balanceTokens: (() => { try { return JSON.parse(wallet.balanceTokens ?? '{}') as Record<string, number>; } catch { return {}; } })(),
        isActive: wallet.isActive,
        createdAt: wallet.createdAt,
        lastUsedAt: wallet.lastUsedAt,
        transactionCount: wallet.transactionCount,
      };
    } catch (error) {
      console.error('❌ Error fetching wallet:', error);
      throw new Error('Failed to fetch wallet');
    }
  }

  /**
   * getPrivateKey: controlled export of private key as base58 string.
   * Used ONLY by buy/sell/transfer server routes that need to pass a raw key to on-chain
   * signing libraries (Jupiter, Raydium, PumpFun). Decrypts → encodes → wipes buffer
   * in a single scope to minimise the window where plaintext is in memory.
   * DO NOT call for any purpose other than transaction signing.
   */

  /**
   * Import an existing wallet with proper encryption and validation.
   * Pass profileWalletAddress to auto-tag the wallet as 'profile' when pub key matches.
   */
  async importWallet(userId: string, walletName: string, privateKeyInput: string, profileWalletAddress?: string | null) {
    this.validateInputs(userId, walletName);
    this.checkRateLimit(userId, 'import');

    try {
      // Ensure user exists in users table
      const user = await prisma.users.findUnique({
        where: { id: userId }
      });

      if (!user) {
        // Create the user if they don't exist
        await prisma.users.create({
          data: {
            id: userId,
            walletAddress: userId, // Using userId as wallet address for auth
            createdAt: new Date(),
            updatedAt: new Date(),
          }
        });
        console.log(`✅ Created user record for ${userId}`);
      }

      // Validate and normalize private key input
      let privateKeyBytes: Uint8Array;

      // Handle different private key formats
      if (privateKeyInput.startsWith('[') && privateKeyInput.endsWith(']')) {
        // Array format: [1,2,3,...]
        const keyArray = JSON.parse(privateKeyInput);
        if (!Array.isArray(keyArray) || keyArray.length !== 64) {
          throw new Error('Invalid private key format: Array must contain exactly 64 numbers');
        }
        privateKeyBytes = new Uint8Array(keyArray);
      } else if (privateKeyInput.length === 128) {
        // Hex format (64 bytes = 128 hex chars)
        privateKeyBytes = new Uint8Array(Buffer.from(privateKeyInput, 'hex'));
      } else if (privateKeyInput.length >= 87 && privateKeyInput.length <= 88) {
        // Base58 format (Phantom wallet export format)
        try {
          // Import base58 for decoding
          const bs58 = await import('bs58');
          privateKeyBytes = bs58.default.decode(privateKeyInput);

          if (privateKeyBytes.length !== 64) {
            throw new Error('Invalid Base58 private key: Must decode to 64 bytes');
          }
        } catch (error) {
          throw new Error('Invalid Base58 private key format. Please check your private key.');
        }
      } else {
        throw new Error('Invalid private key format. Supported formats: Base58 (Phantom), hex (128 chars), or array [1,2,3,...]');
      }

      // Validate the private key by creating a Keypair
      let keypair: any;
      try {
        keypair = SolanaKeypair.fromSecretKey(privateKeyBytes);
      } catch (error) {
        throw new Error('Invalid private key: Cannot create valid Solana keypair');
      }

      const publicKey = keypair.publicKey.toBase58();

      // Check if this wallet already exists (by public key)
      const existingWallet = await prisma.managed_wallets.findFirst({
        where: {
          OR: [
            { userId, publicKey },
            { publicKey } // Check globally to prevent duplicates
          ]
        }
      });

      if (existingWallet) {
        if (existingWallet.userId === userId) {
          throw new Error('You already have this wallet in your account');
        } else {
          throw new Error('This wallet is already managed by another user');
        }
      }

      // Check user wallet limit
      const walletCount = await prisma.managed_wallets.count({
        where: { userId }
      });

      if (walletCount >= SecureWalletService.MAX_WALLETS_PER_USER) {
        throw new Error(`Maximum wallet limit reached (${SecureWalletService.MAX_WALLETS_PER_USER})`);
      }

      // Determine wallet_type — tag as 'profile' if pub key matches the connected profile wallet
      const isProfileWallet = !!profileWalletAddress && publicKey === profileWalletAddress;
      const walletType = isProfileWallet ? 'profile' : 'sniping';
      if (isProfileWallet) {
        console.log(`⭐ Importing wallet tagged as PROFILE wallet (matches connected address)`);
      }

      // Generate unique salt and encrypt the private key
      const salt = crypto.randomBytes(32);
      const walletSalt = salt.toString('hex');
      const encryptedPrivateKey = this.encryptPrivateKey(privateKeyBytes, userId, walletSalt);

      // Create the wallet record
      const wallet = await prisma.managed_wallets.create({
        data: {
          id: crypto.randomUUID(),
          userId,
          walletName,
          publicKey,
          encryptedPrivateKey,
          encryption_salt: walletSalt,
          is_encrypted: true,
          balanceSol: 0,
          isActive: true,
          wallet_type: walletType,
        }
      });

      // Clear sensitive data from memory
      privateKeyBytes.fill(0);

      // Log the successful import (without sensitive data)
      console.log(`🔐 Successfully imported wallet "${walletName}" for user ${userId}`);
      console.log(`   Public Key: ${publicKey}`);
      console.log(`   Wallet Type: ${walletType}`);

      // Invalidate user wallet cache
      this.invalidateUserWalletCache(userId);

      return {
        id: wallet.id,
        walletName: wallet.walletName,
        publicKey: wallet.publicKey,
        balanceSol: 0,
        balanceTokens: {},
        isActive: wallet.isActive,
        createdAt: wallet.createdAt,
        lastUsedAt: null,
        transactionCount: 0,
        wallet_type: walletType,
        isProfileWallet,
      };

    } catch (error) {
      console.error(`❌ Failed to import wallet for user ${userId}:`, error);
      throw error;
    }
  }
  /**
   * Get private key for a wallet, returned as a base58-encoded string.
   * Compatible with server call sites that pass either (walletId, userId) or (walletAddress).
   * Called by all buy/sell/transfer/snipe routes in server.ts.
   */
  async getPrivateKey(walletIdOrAddress: string, userId?: string): Promise<string> {
    let resolvedWalletId = walletIdOrAddress;
    let resolvedUserId = userId || '';

    // If userId is not provided, look up by public key
    if (!userId) {
      const wallet = await prisma.managed_wallets.findFirst({
        where: { publicKey: walletIdOrAddress },
        select: { id: true, userId: true }
      });
      if (!wallet) throw new Error(`Wallet not found for address: ${walletIdOrAddress}`);
      resolvedWalletId = wallet.id;
      resolvedUserId = wallet.userId;
    }

    // ⚠️  IMPORTANT: Do NOT go through getKeypairForSigning here.
    // Keypair.fromSecretKey() shares the input buffer — the finally-block
    // secureWipe(privateKeyBytes) would zero out keypair.secretKey before
    // bs58.encode can read it, producing an all-zero (all-"1") result.
    // Instead: decrypt → encode → wipe, all in one controlled scope.
    let rawKey: Uint8Array | undefined;
    try {
      const walletRecord = await prisma.managed_wallets.findFirst({
        where: { id: resolvedWalletId, userId: resolvedUserId },
        select: { encryptedPrivateKey: true, encryption_salt: true },
      });
      if (!walletRecord?.encryptedPrivateKey || !walletRecord?.encryption_salt) {
        throw new Error('Wallet not found or missing encryption data');
      }
      rawKey = this.decryptPrivateKey(walletRecord.encryptedPrivateKey, resolvedUserId, walletRecord.encryption_salt);
      // Encode BEFORE wiping — strings are immutable value types, safe to return
      const encoded = bs58.encode(rawKey);
      return encoded;
    } finally {
      if (rawKey) this.secureWipe(rawKey);
    }
  }
}

// Create singleton instance
export const secureWalletService = new SecureWalletService();
