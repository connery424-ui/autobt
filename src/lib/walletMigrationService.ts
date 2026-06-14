import { prisma } from './prisma.js';
import { secureWalletService } from './secureWalletService.js';
import * as crypto from 'crypto';
import bs58 from 'bs58';

export class WalletMigrationService {
  /**
   * Check if a wallet needs to be upgraded (missing encryption fields)
   */
  static async isLegacyWallet(walletId: string): Promise<boolean> {
    try {
      const wallet = await prisma.managed_wallets.findUnique({
        where: { id: walletId },
        select: {
          encryptedPrivateKey: true,
          encryption_salt: true,
          is_encrypted: true,
        },
      });

      if (!wallet) {
        throw new Error('Wallet not found');
      }

      // Legacy if missing salt, encrypted key, or not marked as encrypted
      return !wallet.encryption_salt || !wallet.encryptedPrivateKey || !wallet.is_encrypted;
    } catch (error) {
      console.error('Error checking if wallet is legacy:', error);
      throw new Error('Failed to check wallet status');
    }
  }

  /**
   * Get all legacy wallets for a user
   */
  static async getUserLegacyWallets(userId: string) {
    try {
      const allWallets = await prisma.managed_wallets.findMany({
        where: { userId },
        select: {
          id: true,
          walletName: true,
          publicKey: true,
          encryptedPrivateKey: true,
          encryption_salt: true,
          is_encrypted: true,
          createdAt: true,
        },
      });

      const legacyWallets = allWallets.filter(w => 
        !w.encryption_salt || !w.encryptedPrivateKey || !w.is_encrypted
      );

      return {
        total: allWallets.length,
        legacy: legacyWallets.length,
        modern: allWallets.length - legacyWallets.length,
        legacyWallets: legacyWallets.map(w => ({
          id: w.id,
          walletName: w.walletName,
          publicKey: w.publicKey,
          createdAt: w.createdAt,
          missingFields: [
            !w.encryption_salt && 'encryptionSalt',
            !w.encryptedPrivateKey && 'encryptedPrivateKey',
            !w.is_encrypted && 'isEncrypted'
          ].filter(Boolean)
        }))
      };
    } catch (error) {
      console.error('Error getting user legacy wallets:', error);
      throw new Error('Failed to fetch legacy wallets');
    }
  }

  /**
   * Get platform-wide legacy wallet statistics
   */
  static async getPlatformLegacyStats() {
    try {
      const allWallets = await prisma.managed_wallets.findMany({
        select: {
          id: true,
          userId: true,
          walletName: true,
          encryptedPrivateKey: true,
          encryption_salt: true,
          is_encrypted: true,
        },
      });

      const legacyWallets = allWallets.filter(w => 
        !w.encryption_salt || !w.encryptedPrivateKey || !w.is_encrypted
      );

      const userStats = new Map();
      legacyWallets.forEach(wallet => {
        const userId = wallet.userId;
        if (!userStats.has(userId)) {
          userStats.set(userId, { total: 0, legacy: 0 });
        }
        userStats.get(userId).legacy++;
      });

      allWallets.forEach(wallet => {
        const userId = wallet.userId;
        if (!userStats.has(userId)) {
          userStats.set(userId, { total: 0, legacy: 0 });
        }
        userStats.get(userId).total++;
      });

      return {
        platform: {
          totalWallets: allWallets.length,
          legacyWallets: legacyWallets.length,
          modernWallets: allWallets.length - legacyWallets.length,
          legacyPercentage: Math.round((legacyWallets.length / allWallets.length) * 100) || 0,
        },
        byUser: Array.from(userStats.entries()).map(([userId, stats]) => ({
          userId,
          totalWallets: stats.total,
          legacyWallets: stats.legacy,
          modernWallets: stats.total - stats.legacy,
        }))
      };
    } catch (error) {
      console.error('Error getting platform legacy stats:', error);
      throw new Error('Failed to fetch platform statistics');
    }
  }

  /**
   * Attempt to recover private key from legacy wallet format
   * This tries different possible storage formats that might have been used
   */
  private static async recoverLegacyPrivateKey(wallet: any): Promise<Uint8Array> {
    const { encryptedPrivateKey, publicKey } = wallet;

    if (!encryptedPrivateKey) {
      throw new Error('No private key data found in legacy wallet');
    }

    // Try different possible legacy formats
    let privateKeyBytes: Uint8Array;

    try {
      // Format 1: Direct base64 encoded private key (unencrypted)
      privateKeyBytes = new Uint8Array(Buffer.from(encryptedPrivateKey, 'base64'));
      
      // Validate by checking if it generates the correct public key
      const { Keypair } = await import('@solana/web3.js');
      const testKeypair = Keypair.fromSecretKey(privateKeyBytes);
      
      if (testKeypair.publicKey.toBase58() === publicKey) {
        return privateKeyBytes;
      }
    } catch (e) {
      // Format didn't work, try next
    }

    try {
      // Format 2: Hex encoded private key
      privateKeyBytes = new Uint8Array(Buffer.from(encryptedPrivateKey, 'hex'));
      
      const { Keypair } = await import('@solana/web3.js');
      const testKeypair = Keypair.fromSecretKey(privateKeyBytes);
      
      if (testKeypair.publicKey.toBase58() === publicKey) {
        return privateKeyBytes;
      }
    } catch (e) {
      // Format didn't work, try next
    }

    try {
      // Format 3: Base58 encoded private key
      privateKeyBytes = bs58.decode(encryptedPrivateKey);
      
      const { Keypair } = await import('@solana/web3.js');
      const testKeypair = Keypair.fromSecretKey(privateKeyBytes);
      
      if (testKeypair.publicKey.toBase58() === publicKey) {
        return privateKeyBytes;
      }
    } catch (e) {
      // Format didn't work, try next
    }

    try {
      // Format 4: JSON array format [1,2,3,...]
      const jsonArray = JSON.parse(encryptedPrivateKey);
      if (Array.isArray(jsonArray)) {
        privateKeyBytes = new Uint8Array(jsonArray);
        
        const { Keypair } = await import('@solana/web3.js');
        const testKeypair = Keypair.fromSecretKey(privateKeyBytes);
        
        if (testKeypair.publicKey.toBase58() === publicKey) {
          return privateKeyBytes;
        }
      }
    } catch (e) {
      // Format didn't work
    }

    throw new Error('Unable to recover private key from legacy wallet - unknown format');
  }

  /**
   * Upgrade a single legacy wallet to modern encryption
   */
  static async upgradeLegacyWallet(walletId: string, userId: string): Promise<boolean> {
    console.log(`🔄 Starting upgrade for legacy wallet ${walletId}...`);

    try {
      // Get the legacy wallet
      const legacyWallet = await prisma.managed_wallets.findFirst({
        where: { id: walletId, userId },
        select: {
          id: true,
          walletName: true,
          publicKey: true,
          encryptedPrivateKey: true,
          encryption_salt: true,
          is_encrypted: true,
        },
      });

      if (!legacyWallet) {
        throw new Error('Wallet not found or access denied');
      }

      // Check if it's actually a legacy wallet
      if (legacyWallet.encryption_salt && legacyWallet.encryptedPrivateKey && legacyWallet.is_encrypted) {
        console.log('✅ Wallet is already modern - no upgrade needed');
        return true;
      }

      console.log(`📋 Legacy wallet "${legacyWallet.walletName}" needs upgrade`);

      // Recover the private key from legacy format
      const privateKeyBytes = await this.recoverLegacyPrivateKey(legacyWallet);

      // Generate new salt for modern encryption
      const newSalt = crypto.randomBytes(16).toString('hex');

      // Re-encrypt with modern format using secureWalletService
      const secureService = secureWalletService as any;
      const newEncryptedPrivateKey = secureService.encryptPrivateKey(privateKeyBytes, userId, newSalt);

      // Update the wallet with modern encryption
      await prisma.managed_wallets.update({
        where: { id: walletId },
        data: {
          encryptedPrivateKey: newEncryptedPrivateKey,
          encryption_salt: newSalt,
          is_encrypted: true,
          lastUsedAt: new Date(),
        },
      });

      console.log(`✅ Successfully upgraded wallet "${legacyWallet.walletName}" to modern encryption`);
      
      // Secure cleanup
      privateKeyBytes.fill(0);

      return true;
    } catch (error) {
      console.error(`❌ Failed to upgrade legacy wallet ${walletId}:`, error);
      throw new Error(`Wallet upgrade failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Batch upgrade all legacy wallets for a user
   */
  static async upgradeAllUserLegacyWallets(userId: string) {
    console.log(`🔄 Starting batch upgrade for user ${userId}...`);

    try {
      const legacyInfo = await this.getUserLegacyWallets(userId);
      
      if (legacyInfo.legacy === 0) {
        return {
          success: true,
          message: 'No legacy wallets found - all wallets are already modern',
          upgraded: 0,
          failed: 0,
          results: []
        };
      }

      const results = [];
      let upgraded = 0;
      let failed = 0;

      for (const wallet of legacyInfo.legacyWallets) {
        try {
          await this.upgradeLegacyWallet(wallet.id, userId);
          results.push({
            walletId: wallet.id,
            walletName: wallet.walletName,
            success: true,
            error: null
          });
          upgraded++;
        } catch (error) {
          results.push({
            walletId: wallet.id,
            walletName: wallet.walletName,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
          failed++;
        }
      }

      console.log(`✅ Batch upgrade completed: ${upgraded} upgraded, ${failed} failed`);

      return {
        success: failed === 0,
        message: `Upgraded ${upgraded} wallets, ${failed} failed`,
        upgraded,
        failed,
        results
      };
    } catch (error) {
      console.error(`❌ Batch upgrade failed for user ${userId}:`, error);
      throw new Error(`Batch upgrade failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Admin function: Upgrade all legacy wallets on the platform
   */
  static async upgradeAllPlatformLegacyWallets() {
    console.log('🌍 Starting platform-wide legacy wallet upgrade...');

    try {
      const stats = await this.getPlatformLegacyStats();
      
      if (stats.platform.legacyWallets === 0) {
        return {
          success: true,
          message: 'No legacy wallets found on platform',
          totalUsers: 0,
          totalUpgraded: 0,
          totalFailed: 0
        };
      }

      console.log(`📊 Found ${stats.platform.legacyWallets} legacy wallets across ${stats.byUser.length} users`);

      let totalUpgraded = 0;
      let totalFailed = 0;
      const userResults = [];

      for (const userStat of stats.byUser) {
        if (userStat.legacyWallets > 0) {
          try {
            console.log(`🔄 Upgrading ${userStat.legacyWallets} legacy wallets for user ${userStat.userId}`);
            
            const result = await this.upgradeAllUserLegacyWallets(userStat.userId);
            
            userResults.push({
              userId: userStat.userId,
              success: result.success,
              upgraded: result.upgraded,
              failed: result.failed
            });

            totalUpgraded += result.upgraded;
            totalFailed += result.failed;
          } catch (error) {
            console.error(`❌ Failed to upgrade wallets for user ${userStat.userId}:`, error);
            userResults.push({
              userId: userStat.userId,
              success: false,
              upgraded: 0,
              failed: userStat.legacyWallets,
              error: error instanceof Error ? error.message : 'Unknown error'
            });
            totalFailed += userStat.legacyWallets;
          }
        }
      }

      console.log(`🎉 Platform upgrade completed: ${totalUpgraded} wallets upgraded, ${totalFailed} failed`);

      return {
        success: totalFailed === 0,
        message: `Platform upgrade completed: ${totalUpgraded} upgraded, ${totalFailed} failed`,
        totalUsers: userResults.length,
        totalUpgraded,
        totalFailed,
        userResults
      };
    } catch (error) {
      console.error('❌ Platform-wide upgrade failed:', error);
      throw new Error(`Platform upgrade failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}

export const walletMigrationService = WalletMigrationService;
