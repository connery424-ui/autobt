/**
 * LaunchLab Service — LetsBonk / Raydium LaunchLab tokens
 *
 * Program: LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj
 * Source reference: learning-examples/letsbonk-buy-sell/manual_buy_exact_in.py
 *
 * Tokens on LetsBonk use the Raydium LaunchLab program with a different instruction
 * layout than pump.fun. Uses buy_exact_in with WSOL createAccountWithSeed wrapping.
 */

import {
    Connection, PublicKey, VersionedTransaction, TransactionMessage,
    TransactionInstruction, SystemProgram, SYSVAR_RENT_PUBKEY
} from '@solana/web3.js';
import {
    getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction,
    TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { Buffer } from 'buffer';
import crypto from 'crypto';

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
export const LAUNCHLAB_PROGRAM = new PublicKey('LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj');
export const LETSBONK_GLOBAL_CFG = new PublicKey('6s1xP3hpbAfFoNtUNF8mfHsjr2Bd97JxFJRWLbL6aHuX');
export const LETSBONK_PLATFORM = new PublicKey('5thqcDwKp5QQ8US4XRMoseGeGbmLKMmoKZmS6zHrQAsA');
export const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

// Instruction discriminators from IDL
const BUY_EXACT_IN_DISC = Buffer.from([250, 234, 13, 123, 213, 156, 19, 236]);
const SELL_EXACT_IN_DISC = Buffer.from([149, 39, 222, 155, 211, 124, 152, 26]);


const ATA_RENT_EXEMPTION = 2_039_280; // lamports for a token account

// ─── POOL STATE LAYOUT ───────────────────────────────────────────────────────
// PoolState from Raydium LaunchLab IDL. Fields parsed using offsets:
// [8]  discriminator
// [1]  bump
// [8]  amm_config / status   → we read status at offset 9
// ... actual field offsets discovered from trade examples + IDL
// For now we store the fields we need: virtual_base, virtual_quote, base_vault, quote_vault, creator

export interface LaunchLabPoolState {
    poolAddress: string;
    virtualBase: bigint;
    virtualQuote: bigint;
    realBase: bigint;
    realQuote: bigint;
    baseVault: string;
    quoteVault: string;
    creator: string;
    status: number;
}

// ─── SERVICE ─────────────────────────────────────────────────────────────────
export class LaunchLabService {
    private connection: Connection;

    constructor(connection: Connection) {
        this.connection = connection;
    }

    // ─── PDA Helpers ──────────────────────────────────────────────────────
    private static pda(seeds: (Buffer | Uint8Array)[], prog: PublicKey): PublicKey {
        return PublicKey.findProgramAddressSync(seeds, prog)[0];
    }

    /** Pool state PDA: seeds = ["pool", baseMint, WSOL_MINT] */
    static poolStatePda(baseMint: PublicKey): PublicKey {
        return LaunchLabService.pda([Buffer.from('pool'), baseMint.toBytes(), WSOL_MINT.toBytes()], LAUNCHLAB_PROGRAM);
    }

    /** Authority PDA: seeds = ["vault_auth_seed"] */
    static authorityPda(): PublicKey {
        return LaunchLabService.pda([Buffer.from('vault_auth_seed')], LAUNCHLAB_PROGRAM);
    }

    /** Event authority PDA */
    static eventAuthorityPda(): PublicKey {
        return LaunchLabService.pda([Buffer.from('__event_authority')], LAUNCHLAB_PROGRAM);
    }

    /** Creator fee vault PDA: seeds = [creator, WSOL_MINT] */
    static creatorFeeVault(creator: PublicKey): PublicKey {
        return LaunchLabService.pda([creator.toBytes(), WSOL_MINT.toBytes()], LAUNCHLAB_PROGRAM);
    }

    /** Platform fee vault PDA: seeds = [platformConfig, WSOL_MINT] */
    static platformFeeVault(): PublicKey {
        return LaunchLabService.pda([LETSBONK_PLATFORM.toBytes(), WSOL_MINT.toBytes()], LAUNCHLAB_PROGRAM);
    }

    /**
     * Check if a token exists on LetsBonk (by checking if pool state account exists).
     */
    async hasPool(tokenMint: string): Promise<boolean> {
        try {
            const poolPda = LaunchLabService.poolStatePda(new PublicKey(tokenMint));
            const poolInfo = await this.connection.getAccountInfo(poolPda);
            return poolInfo !== null && poolInfo.data.length > 50;
        } catch {
            return false;
        }
    }

    /**
     * Get and decode LetsBonk pool state.
     * Uses the idl_parser field ordering from learning examples.
     * Field offsets derived from Raydium LaunchLab IDL:
     *   [8]  discriminator
     *   [1]  epoch (or bump)
     *   [8]  amm_config
     *   [32] auth_bump (actually the next pubkey fields start here)
     *
     * We use the IDL-verified field offsets from the Python examples.
     */
    async getPoolState(tokenMint: string): Promise<LaunchLabPoolState | null> {
        try {
            const mint = new PublicKey(tokenMint);
            const poolPda = LaunchLabService.poolStatePda(mint);
            const info = await this.connection.getAccountInfo(poolPda);
            if (!info) return null;

            const d = Buffer.from(info.data);
            // Parse using known field offsets from IDL (skip discriminator at 0..8)
            // Layout from Raydium LaunchLab IDL PoolState:
            // offset 8:   epoch (u8)
            // offset 9:   auth (pubkey 32)
            // offset 41:  amm_config (pubkey 32)
            // offset 73:  creator (pubkey 32)
            // offset 105: base_mint (pubkey 32)
            // offset 137: quote_mint (pubkey 32)
            // offset 169: base_vault (pubkey 32)
            // offset 201: quote_vault (pubkey 32)
            // offset 233: lp_mint (pubkey 32)
            // offset 265: lp_supply (u64)
            // offset 273: real_base (u64)
            // offset 281: real_quote (u64)
            // offset 289: virtual_base (u64)
            // offset 297: virtual_quote (u64)
            // offset 305: status (u8)
            const creator = new PublicKey(d.slice(73, 105)).toBase58();
            const baseVault = new PublicKey(d.slice(169, 201)).toBase58();
            const quoteVault = new PublicKey(d.slice(201, 233)).toBase58();
            const realBase = d.readBigUInt64LE(273);
            const realQuote = d.readBigUInt64LE(281);
            const virtualBase = d.readBigUInt64LE(289);
            const virtualQuote = d.readBigUInt64LE(297);
            const status = d.length > 305 ? d[305] : 0;

            return { poolAddress: poolPda.toBase58(), virtualBase, virtualQuote, realBase, realQuote, baseVault, quoteVault, creator, status };
        } catch (e) {
            console.error('LaunchLab getPoolState error:', e);
            return null;
        }
    }

    /**
     * Calculate minimum tokens out using constant-product AMM formula (BUY).
     * amount_out = (amount_in * virtual_base) / (virtual_quote + amount_in)
     */
    static calcMinAmountOut(poolState: LaunchLabPoolState, amountInLamports: bigint, slippageBps: number): bigint {
        const { virtualBase, virtualQuote } = poolState;
        const expectedOut = (amountInLamports * virtualBase) / (virtualQuote + amountInLamports);
        return (expectedOut * BigInt(10000 - slippageBps)) / 10000n;
    }

    /**
     * Calculate minimum SOL out using constant-product AMM formula (SELL).
     * amount_out = (amount_in * virtual_quote) / (virtual_base + amount_in)
     */
    static calcSellMinAmountOut(poolState: LaunchLabPoolState, amountInTokens: bigint, slippageBps: number): bigint {
        const { virtualBase, virtualQuote } = poolState;
        const expectedOut = (amountInTokens * virtualQuote) / (virtualBase + amountInTokens);
        return (expectedOut * BigInt(10000 - slippageBps)) / 10000n;
    }

    /**
     * Build instructions to create a WSOL token account using createAccountWithSeed.
     * This matches the exact pattern from the LetsBonk examples.
     */
    private static buildWsolAccountWithSeed(
        payer: PublicKey,
        lamports: number,
    ): { wsolAcct: PublicKey; createIx: TransactionInstruction; initIx: TransactionInstruction } {
        const seed = crypto.randomBytes(16).toString('hex').slice(0, 32);
        const wsolAcct = PublicKey.createWithSeed(payer, seed, TOKEN_PROGRAM_ID);

        // createAccountWithSeed instruction (system program instruction 11)
        const createData = Buffer.allocUnsafe(4 + 8 + 8 + 4 + seed.length + 32);
        let off = 0;
        createData.writeUInt32LE(11, off); off += 4;                                   // createAccountWithSeed
        createData.writeBigUInt64LE(BigInt(lamports), off); off += 8;                  // lamports
        createData.writeBigUInt64LE(165n, off); off += 8;                              // space (token account = 165)
        createData.writeUInt32LE(seed.length, off); off += 4;                         // seed length
        createData.write(seed, off, 'utf-8'); off += seed.length;                     // seed string
        TOKEN_PROGRAM_ID.toBuffer().copy(createData, off);                            // owner = TOKEN_PROGRAM_ID

        const createIx = new TransactionInstruction({
            programId: SystemProgram.programId,
            keys: [
                { pubkey: payer, isSigner: true, isWritable: true },
                { pubkey: wsolAcct, isSigner: false, isWritable: true },
                { pubkey: payer, isSigner: true, isWritable: false }, // base
            ],
            data: createData,
        });

        // InitializeAccount instruction (Token program instruction 1)
        const initData = Buffer.from([1]); // InitializeAccount discriminator
        const initIx = new TransactionInstruction({
            programId: TOKEN_PROGRAM_ID,
            keys: [
                { pubkey: wsolAcct, isSigner: false, isWritable: true },
                { pubkey: WSOL_MINT, isSigner: false, isWritable: false },
                { pubkey: payer, isSigner: false, isWritable: false },
                { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
            ],
            data: initData,
        });

        return { wsolAcct, createIx, initIx };
    }

    /**
     * Buy token on LetsBonk/LaunchLab using buy_exact_in instruction.
     * Transaction structure (from letsbonk-buy-sell/manual_buy_exact_in.py):
     * 1. SetComputeUnitPrice
     * 2. SetComputeUnitLimit
     * 3. Create ATA for base token (idempotent)
     * 4. Create WSOL account with seed
     * 5. Initialize WSOL account
     * 6. buy_exact_in (18-account instruction)
     * 7. Close WSOL account
     */
    async buyExactIn(
        tokenMint: string,
        amountSol: number,
        slippageBps: number,
        walletPublicKey: string,
    ): Promise<{ transaction: VersionedTransaction; quote: any } | null> {
        const mint = new PublicKey(tokenMint);
        const buyer = new PublicKey(walletPublicKey);
        const conn = this.connection;

        // 1. Get pool state
        const poolState = await this.getPoolState(tokenMint);
        if (!poolState) throw new Error(`No LaunchLab pool for ${tokenMint}`);

        const poolPda = new PublicKey(poolState.poolAddress);
        const creator = new PublicKey(poolState.creator);
        const authority = LaunchLabService.authorityPda();
        const eventAuth = LaunchLabService.eventAuthorityPda();
        const creatorFeeVault = LaunchLabService.creatorFeeVault(creator);
        const platformFeeVault = LaunchLabService.platformFeeVault();

        // 2. Calculate amounts
        const amountIn = BigInt(Math.floor(amountSol * 1e9));
        const minAmountOut = LaunchLabService.calcMinAmountOut(poolState, amountIn, slippageBps);
        const expectedOut = Number((amountIn * poolState.virtualBase) / (poolState.virtualQuote + amountIn));

        // 3. Derive user token accounts
        const userBaseAta = getAssociatedTokenAddressSync(mint, buyer, false, TOKEN_PROGRAM_ID);
        const baseVault = new PublicKey(poolState.baseVault);
        const quoteVault = new PublicKey(poolState.quoteVault);

        // 4. WSOL account with createAccountWithSeed (exact pattern from example)
        const totalLamports = Number(amountIn) + ATA_RENT_EXEMPTION;
        const { wsolAcct: userQuoteToken, createIx: createWsolIx, initIx: initWsolIx } =
            LaunchLabService.buildWsolAccountWithSeed(buyer, totalLamports);

        const ixs: TransactionInstruction[] = [];

        // SetComputeUnitPrice FIRST, then Limit (per example)
        ixs.push(new TransactionInstruction({
            programId: new PublicKey('ComputeBudget111111111111111111111111111111'),
            keys: [],
            data: (() => { const b = Buffer.allocUnsafe(9); b[0] = 3; b.writeBigUInt64LE(5000n, 1); return b; })(),
        }));
        ixs.push(new TransactionInstruction({
            programId: new PublicKey('ComputeBudget111111111111111111111111111111'),
            keys: [],
            data: (() => { const b = Buffer.allocUnsafe(5); b[0] = 2; b.writeUInt32LE(150_000, 1); return b; })(),
        }));

        // Create base token ATA (idempotent)
        const baseAtaInfo = await conn.getAccountInfo(userBaseAta);
        if (!baseAtaInfo) {
            ixs.push(createAssociatedTokenAccountInstruction(buyer, userBaseAta, buyer, mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
        } else {
            // Use idempotent variant (instruction type 1)
            ixs.push(new TransactionInstruction({
                programId: ASSOCIATED_TOKEN_PROGRAM_ID,
                keys: [
                    { pubkey: buyer, isSigner: true, isWritable: true },
                    { pubkey: userBaseAta, isSigner: false, isWritable: true },
                    { pubkey: buyer, isSigner: false, isWritable: false },
                    { pubkey: mint, isSigner: false, isWritable: false },
                    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                ],
                data: Buffer.from([1]), // CreateIdempotent
            }));
        }

        // Create + init WSOL account
        ixs.push(createWsolIx);
        ixs.push(initWsolIx);

        // 5. buy_exact_in instruction (18 accounts: 15 IDL + 3 remaining)
        const instrData = Buffer.allocUnsafe(8 + 8 + 8 + 8);
        BUY_EXACT_IN_DISC.copy(instrData, 0);
        instrData.writeBigUInt64LE(amountIn, 8);   // amount_in
        instrData.writeBigUInt64LE(minAmountOut, 16);  // minimum_amount_out
        instrData.writeBigUInt64LE(0n, 24);  // share_fee_rate = 0

        ixs.push(new TransactionInstruction({
            programId: LAUNCHLAB_PROGRAM,
            data: instrData,
            keys: [
                { pubkey: buyer, isSigner: true, isWritable: false }, // 0: payer
                { pubkey: authority, isSigner: false, isWritable: false }, // 1: authority
                { pubkey: LETSBONK_GLOBAL_CFG, isSigner: false, isWritable: false }, // 2: global_config
                { pubkey: LETSBONK_PLATFORM, isSigner: false, isWritable: false }, // 3: platform_config
                { pubkey: poolPda, isSigner: false, isWritable: true }, // 4: pool_state
                { pubkey: userBaseAta, isSigner: false, isWritable: true }, // 5: user_base_token
                { pubkey: userQuoteToken, isSigner: false, isWritable: true }, // 6: user_quote_token
                { pubkey: baseVault, isSigner: false, isWritable: true }, // 7: base_vault
                { pubkey: quoteVault, isSigner: false, isWritable: true }, // 8: quote_vault
                { pubkey: mint, isSigner: false, isWritable: false }, // 9: base_token_mint
                { pubkey: WSOL_MINT, isSigner: false, isWritable: false }, // 10: quote_token_mint
                { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // 11: base_token_program
                { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // 12: quote_token_program
                { pubkey: eventAuth, isSigner: false, isWritable: false }, // 13: event_authority
                { pubkey: LAUNCHLAB_PROGRAM, isSigner: false, isWritable: false }, // 14: program
                // Remaining accounts (3):
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // 15: system_program
                { pubkey: platformFeeVault, isSigner: false, isWritable: true }, // 16: platform_fee_vault
                { pubkey: creatorFeeVault, isSigner: false, isWritable: true }, // 17: creator_fee_vault
            ],
        }));

        // 6. Close WSOL account (recover rent + leftover SOL)
        ixs.push(new TransactionInstruction({
            programId: TOKEN_PROGRAM_ID,
            keys: [
                { pubkey: userQuoteToken, isSigner: false, isWritable: true },
                { pubkey: buyer, isSigner: false, isWritable: true },
                { pubkey: buyer, isSigner: true, isWritable: false },
            ],
            data: Buffer.from([9]), // CloseAccount
        }));

        const { blockhash } = await conn.getLatestBlockhash('confirmed');
        const msg = new TransactionMessage({ payerKey: buyer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
        const transaction = new VersionedTransaction(msg);

        const tokensOutNum = expectedOut / 1e6;
        console.log(`📊 LaunchLab buy: ~${tokensOutNum.toFixed(0)} tokens for ${amountSol} SOL (pool: ${poolPda.toBase58().slice(0, 8)}...)`);

        return {
            transaction,
            quote: {
                tokensOut: tokensOutNum,
                minTokensOut: Number(minAmountOut) / 1e6,
                priceImpact: 0,
                effectivePrice: amountSol / tokensOutNum,
                poolAddress: poolPda.toBase58(),
            },
        };
    }

    /**
     * Sell token on LetsBonk/LaunchLab using sell_exact_in instruction.
     * Transaction structure (from letsbonk-buy-sell/manual_sell_exact_in.py):
     * 1. SetComputeUnitPrice
     * 2. SetComputeUnitLimit
     * 3. Create WSOL account with seed (receives SOL proceeds)
     * 4. Initialize WSOL account
     * 5. sell_exact_in (18-account instruction)
     * 6. Close WSOL account (unwrap SOL)
     */
    async sellExactIn(
        tokenMint: string,
        tokenAmountRaw: bigint,
        slippageBps: number,
        walletPublicKey: string,
    ): Promise<{ transaction: VersionedTransaction; quote: any } | null> {
        const mint = new PublicKey(tokenMint);
        const seller = new PublicKey(walletPublicKey);
        const conn = this.connection;

        // 1. Get pool state
        const poolState = await this.getPoolState(tokenMint);
        if (!poolState) throw new Error(`No LaunchLab pool for ${tokenMint}`);

        const poolPda = new PublicKey(poolState.poolAddress);
        const creator = new PublicKey(poolState.creator);
        const authority = LaunchLabService.authorityPda();
        const eventAuth = LaunchLabService.eventAuthorityPda();
        const creatorFeeVault = LaunchLabService.creatorFeeVault(creator);
        const platformFeeVault = LaunchLabService.platformFeeVault();

        // 2. Calculate minimum SOL out
        const minSolOut = LaunchLabService.calcSellMinAmountOut(poolState, tokenAmountRaw, slippageBps);
        const expectedSolOut = Number((tokenAmountRaw * poolState.virtualQuote) / (poolState.virtualBase + tokenAmountRaw));

        if (minSolOut <= 0n) {
            throw new Error('Sell amount too small — would receive 0 SOL');
        }

        // 3. User's base token ATA (source of tokens being sold)
        const userBaseAta = getAssociatedTokenAddressSync(mint, seller, false, TOKEN_PROGRAM_ID);
        const baseVault = new PublicKey(poolState.baseVault);
        const quoteVault = new PublicKey(poolState.quoteVault);

        // 4. WSOL account with createAccountWithSeed (receives SOL proceeds)
        const { wsolAcct: userQuoteToken, createIx: createWsolIx, initIx: initWsolIx } =
            LaunchLabService.buildWsolAccountWithSeed(seller, ATA_RENT_EXEMPTION);

        const ixs: TransactionInstruction[] = [];

        // SetComputeUnitPrice + Limit
        ixs.push(new TransactionInstruction({
            programId: new PublicKey('ComputeBudget111111111111111111111111111111'),
            keys: [],
            data: (() => { const b = Buffer.allocUnsafe(9); b[0] = 3; b.writeBigUInt64LE(5000n, 1); return b; })(),
        }));
        ixs.push(new TransactionInstruction({
            programId: new PublicKey('ComputeBudget111111111111111111111111111111'),
            keys: [],
            data: (() => { const b = Buffer.allocUnsafe(5); b[0] = 2; b.writeUInt32LE(150_000, 1); return b; })(),
        }));

        // Create + init WSOL receive account
        ixs.push(createWsolIx);
        ixs.push(initWsolIx);

        // 5. sell_exact_in instruction (18 accounts: 15 IDL + 3 remaining)
        const instrData = Buffer.allocUnsafe(8 + 8 + 8 + 8);
        SELL_EXACT_IN_DISC.copy(instrData, 0);
        instrData.writeBigUInt64LE(tokenAmountRaw, 8);   // amount_in (tokens to sell)
        instrData.writeBigUInt64LE(minSolOut, 16);        // minimum_amount_out (min SOL)
        instrData.writeBigUInt64LE(0n, 24);               // share_fee_rate = 0

        ixs.push(new TransactionInstruction({
            programId: LAUNCHLAB_PROGRAM,
            data: instrData,
            keys: [
                { pubkey: seller, isSigner: true, isWritable: false },     // 0: payer
                { pubkey: authority, isSigner: false, isWritable: false },  // 1: authority
                { pubkey: LETSBONK_GLOBAL_CFG, isSigner: false, isWritable: false },  // 2: global_config
                { pubkey: LETSBONK_PLATFORM, isSigner: false, isWritable: false },    // 3: platform_config
                { pubkey: poolPda, isSigner: false, isWritable: true },    // 4: pool_state
                { pubkey: userBaseAta, isSigner: false, isWritable: true },// 5: user_base_token (tokens sold)
                { pubkey: userQuoteToken, isSigner: false, isWritable: true }, // 6: user_quote_token (WSOL recv)
                { pubkey: baseVault, isSigner: false, isWritable: true },  // 7: base_vault
                { pubkey: quoteVault, isSigner: false, isWritable: true }, // 8: quote_vault
                { pubkey: mint, isSigner: false, isWritable: false },      // 9: base_token_mint
                { pubkey: WSOL_MINT, isSigner: false, isWritable: false }, // 10: quote_token_mint
                { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // 11: base_token_program
                { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // 12: quote_token_program
                { pubkey: eventAuth, isSigner: false, isWritable: false }, // 13: event_authority
                { pubkey: LAUNCHLAB_PROGRAM, isSigner: false, isWritable: false }, // 14: program
                // Remaining accounts (3):
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // 15: system_program
                { pubkey: platformFeeVault, isSigner: false, isWritable: true }, // 16: platform_fee_vault
                { pubkey: creatorFeeVault, isSigner: false, isWritable: true }, // 17: creator_fee_vault
            ],
        }));

        // 6. Close WSOL account (unwrap SOL proceeds)
        ixs.push(new TransactionInstruction({
            programId: TOKEN_PROGRAM_ID,
            keys: [
                { pubkey: userQuoteToken, isSigner: false, isWritable: true },
                { pubkey: seller, isSigner: false, isWritable: true },
                { pubkey: seller, isSigner: true, isWritable: false },
            ],
            data: Buffer.from([9]), // CloseAccount
        }));

        const { blockhash } = await conn.getLatestBlockhash('confirmed');
        const msg = new TransactionMessage({ payerKey: seller, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
        const transaction = new VersionedTransaction(msg);

        const solOutNum = expectedSolOut / 1e9;
        console.log(`📊 LaunchLab sell: tokens → ~${solOutNum.toFixed(6)} SOL (pool: ${poolPda.toBase58().slice(0, 8)}...)`);

        return {
            transaction,
            quote: {
                solReceived: solOutNum,
                minSolReceived: Number(minSolOut) / 1e9,
                priceImpact: 0,
                poolAddress: poolPda.toBase58(),
            },
        };
    }
}
