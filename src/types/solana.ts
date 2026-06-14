/**
 * Solana Web3.js Type Fixes
 * 
 * This file addresses TypeScript namespace errors with @solana/web3.js imports.
 * The main issue is that some Solana types are being treated as namespaces instead of types.
 * 
 * SOLUTION: Use proper type-only imports and type aliases to resolve namespace conflicts.
 */

// Re-export Solana types to resolve namespace issues
export type {
  Connection,
  PublicKey,
  Keypair,
  VersionedTransaction,
  Transaction,
  TransactionSignature,
  TransactionInstruction,
  ParsedConfirmedTransaction,
  LAMPORTS_PER_SOL
} from '@solana/web3.js';

// For cases where we need the actual classes/values, import them separately
import * as SolanaWeb3 from '@solana/web3.js';

// Provide clean exports for both types and values
export const {
  Connection: SolanaConnection,
  PublicKey: SolanaPublicKey,
  Keypair: SolanaKeypair,
  VersionedTransaction: SolanaVersionedTransaction,
  Transaction: SolanaTransaction,
  SystemProgram: SolanaSystemProgram,
  LAMPORTS_PER_SOL: SolanaLamportsPerSol
} = SolanaWeb3;

// Type aliases to avoid namespace conflicts
export type SolanaConnectionType = InstanceType<typeof SolanaConnection>;
export type SolanaPublicKeyType = InstanceType<typeof SolanaPublicKey>;
export type SolanaKeypairType = InstanceType<typeof SolanaKeypair>;
export type SolanaVersionedTransactionType = InstanceType<typeof SolanaVersionedTransaction>;
export type SolanaTransactionType = InstanceType<typeof SolanaTransaction>;

/**
 * USAGE EXAMPLES:
 * 
 * // For type annotations, use the type exports:
 * const connection: SolanaConnectionType = new SolanaConnection(rpcUrl);
 * const keypair: SolanaKeypairType = SolanaKeypair.generate();
 * 
 * // For creating instances, use the class exports:
 * const newKeypair = SolanaKeypair.generate();
 * const publicKey = new SolanaPublicKey(address);
 * 
 * // This avoids "Cannot use namespace 'X' as a type" errors
 */
