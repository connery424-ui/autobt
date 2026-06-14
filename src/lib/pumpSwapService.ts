/**
 * PumpSwap Service — for pump.fun tokens that have GRADUATED from the bonding curve
 *
 * Graduated tokens trade on the PUMP AMM (pAMM), program: pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA
 * Source reference: learning-examples/pumpswap/manual_buy_pumpswap.py
 */

import {
    Connection, PublicKey, VersionedTransaction, TransactionMessage,
    SystemProgram, ComputeBudgetProgram, TransactionInstruction
} from '@solana/web3.js';
import {
    getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction,
    createSyncNativeInstruction, createCloseAccountInstruction,
    TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { Buffer } from 'buffer';

// ─── CONSTANTS FROM LEARNING EXAMPLES ────────────────────────────────────────
export const PUMP_AMM_PROGRAM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
export const PUMP_AMM_GLOBAL_CFG = new PublicKey('ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw');
export const PUMP_AMM_EVENT_AUTH = new PublicKey('GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR');
export const PUMP_AMM_FEE_PROG = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
export const PUMPSWAP_STD_FEE = new PublicKey('7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ');
export const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
export const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

// Instruction discriminators
const BUY_DISC = Buffer.from('66063d1201daebea', 'hex');  // pAMM buy
const SELL_DISC = Buffer.from('33e685a4017f83ad', 'hex');  // pAMM sell

// Pool account structure offsets (from pumpswap/manual_buy_pumpswap.py)
const POOL_BASE_MINT_OFFSET = 43;
const POOL_MAYHEM_MODE_OFFSET = 243;
const GLOBALCFG_FEE_OFFSET = 72; // 8 discriminator + 32 admin + 32 default_fee_recipient = offset to reserved

// ─── TYPES ───────────────────────────────────────────────────────────────────
export interface PumpSwapPoolData {
    poolAddress: string;
    creator: string;
    baseMint: string;
    quoteMint: string;
    lpMint: string;
    poolBaseTokenAccount: string;
    poolQuoteTokenAccount: string;
    lpSupply: bigint;
    coinCreator: string;
    isMayhemMode: boolean;
}

// ─── SERVICE ─────────────────────────────────────────────────────────────────
export class PumpSwapService {
    private connection: Connection;

    constructor(connection: Connection) {
        this.connection = connection;
    }

    // ─── PDA Helpers ────────────────────────────────────────────────────────
    private static pda(seeds: (Buffer | Uint8Array)[], prog: PublicKey): PublicKey {
        return PublicKey.findProgramAddressSync(seeds, prog)[0];
    }
    static coinCreatorVault(creator: PublicKey) { return PumpSwapService.pda([Buffer.from('creator_vault'), creator.toBytes()], PUMP_AMM_PROGRAM); }
    static globalVolumeAcc() { return PumpSwapService.pda([Buffer.from('global_volume_accumulator')], PUMP_AMM_PROGRAM); }
    static userVolumeAcc(user: PublicKey) { return PumpSwapService.pda([Buffer.from('user_volume_accumulator'), user.toBytes()], PUMP_AMM_PROGRAM); }
    static feeConfigPda() { return PumpSwapService.pda([Buffer.from('fee_config'), PUMP_AMM_PROGRAM.toBytes()], PUMP_AMM_FEE_PROG); }

    // ─── Pool Discovery ─────────────────────────────────────────────────────
    /**
     * Find the pAMM pool address for a token mint.
     * Uses getProgramAccounts with base_mint memcmp at offset 43.
     */
    async findPoolByMint(baseMint: string): Promise<string | null> {
        try {
            const mint = new PublicKey(baseMint);
            const accounts = await this.connection.getProgramAccounts(PUMP_AMM_PROGRAM, {
                filters: [{ memcmp: { offset: POOL_BASE_MINT_OFFSET, bytes: mint.toBase58() } }],
            });
            return accounts.length > 0 ? accounts[0].pubkey.toBase58() : null;
        } catch (e) {
            console.error('PumpSwap findPoolByMint error:', e);
            return null;
        }
    }

    /**
     * Parse raw pool account binary data.
     * Field layout from pumpswap/manual_buy_pumpswap.py get_market_data().
     */
    parsePoolData(poolAddress: string, data: Buffer): PumpSwapPoolData {
        let offset = 8; // skip discriminator

        const u8 = () => { const v = data[offset]; offset += 1; return v; };
        const u16 = () => { const v = data.readUInt16LE(offset); offset += 2; return v; };
        const u64 = () => { const v = data.readBigUInt64LE(offset); offset += 8; return v; };
        const pk = () => { const v = new PublicKey(data.slice(offset, offset + 32)).toBase58(); offset += 32; return v; };

        u8();          // pool_bump
        u16();         // index
        const creator = pk();
        const baseMint = pk();
        const quoteMint = pk();
        const lpMint = pk();
        const poolBaseTokenAccount = pk();
        const poolQuoteTokenAccount = pk();
        const lpSupply = u64();
        const coinCreator = pk();

        const isMayhemMode = data.length >= POOL_MAYHEM_MODE_OFFSET + 1 && data[POOL_MAYHEM_MODE_OFFSET] !== 0;

        return { poolAddress, creator, baseMint, quoteMint, lpMint, poolBaseTokenAccount, poolQuoteTokenAccount, lpSupply, coinCreator, isMayhemMode };
    }

    /**
     * Get parsed pool data for a pool address.
     */
    async getPoolData(poolAddress: string): Promise<PumpSwapPoolData | null> {
        try {
            const info = await this.connection.getAccountInfo(new PublicKey(poolAddress));
            if (!info) return null;
            return this.parsePoolData(poolAddress, Buffer.from(info.data));
        } catch (e) {
            console.error('PumpSwap getPoolData error:', e);
            return null;
        }
    }

    /**
     * Get fee recipient for a pool, handling mayhem mode.
     */
    async getFeeRecipient(isMayhemMode: boolean): Promise<PublicKey> {
        if (!isMayhemMode) return PUMPSWAP_STD_FEE;
        try {
            const info = await this.connection.getAccountInfo(PUMP_AMM_GLOBAL_CFG);
            if (!info || info.data.length < GLOBALCFG_FEE_OFFSET + 32) return PUMPSWAP_STD_FEE;
            return new PublicKey(info.data.slice(GLOBALCFG_FEE_OFFSET, GLOBALCFG_FEE_OFFSET + 32));
        } catch {
            return PUMPSWAP_STD_FEE;
        }
    }

    /**
     * Get token amounts from pool vault balances.
     */
    async getPoolPrice(pool: PumpSwapPoolData): Promise<{ baseAmount: number; quoteAmount: number; pricePerToken: number }> {
        const [base, quote] = await Promise.all([
            this.connection.getTokenAccountBalance(new PublicKey(pool.poolBaseTokenAccount)),
            this.connection.getTokenAccountBalance(new PublicKey(pool.poolQuoteTokenAccount)),
        ]);
        const baseAmount = base.value.uiAmount ?? 0;
        const quoteAmount = quote.value.uiAmount ?? 0;
        return { baseAmount, quoteAmount, pricePerToken: quoteAmount / baseAmount };
    }

    /**
     * Check if a token has a pAMM pool (has graduated from bonding curve).
     */
    async isGraduated(tokenMint: string): Promise<boolean> {
        return (await this.findPoolByMint(tokenMint)) !== null;
    }

    /**
     * Buy a graduated token via PumpSwap pAMM.
     * Wraps SOL → WSOL, builds buy instruction with full account list.
     */
    async buyPumpSwap(
        tokenMint: string,
        amountSol: number,
        slippageBps: number,
        walletPublicKey: string,
    ): Promise<{ transaction: VersionedTransaction; quote: any } | null> {
        const mint = new PublicKey(tokenMint);
        const buyer = new PublicKey(walletPublicKey);
        const conn = this.connection;

        // 1. Find pool
        const poolAddr = await this.findPoolByMint(tokenMint);
        if (!poolAddr) throw new Error(`No pAMM pool found for ${tokenMint} — token may still be pre-bonded`);

        const pool = await this.getPoolData(poolAddr);
        if (!pool) throw new Error(`Could not read pAMM pool data for ${poolAddr}`);

        // 2. Get current price from vault balances
        const { baseAmount, quoteAmount, pricePerToken } = await this.getPoolPrice(pool);
        const tokensOutExpected = amountSol / pricePerToken;
        const tokenDecimals = 6;

        const solLamports = Math.floor(amountSol * 1e9);
        const baseAmountOut = Math.floor((tokensOutExpected) * 10 ** tokenDecimals);
        const maxSolInput = Math.floor(solLamports * (1 + slippageBps / 10000));

        // 3. Determine token program and fee recipient
        const mintInfo = await conn.getAccountInfo(mint);
        const tokenProg = mintInfo?.owner.toBase58() === TOKEN_2022.toBase58() ? TOKEN_2022 : TOKEN_PROGRAM_ID;
        const feeRecipient = await this.getFeeRecipient(pool.isMayhemMode);
        const feeRecipientTokenAcct = getAssociatedTokenAddressSync(WSOL_MINT, feeRecipient, true, TOKEN_PROGRAM_ID);

        // 4. Derive PDAs and token accounts
        const poolKey = new PublicKey(poolAddr);
        const coinCreator = new PublicKey(pool.coinCreator);
        const creatorVaultAuth = PumpSwapService.coinCreatorVault(coinCreator);
        const creatorVaultAta = getAssociatedTokenAddressSync(WSOL_MINT, creatorVaultAuth, true, TOKEN_PROGRAM_ID);
        const globalVolAcc = PumpSwapService.globalVolumeAcc();
        const userVolAcc = PumpSwapService.userVolumeAcc(buyer);
        const feeConfig = PumpSwapService.feeConfigPda();
        const userBaseAta = getAssociatedTokenAddressSync(mint, buyer, false, tokenProg);
        const userWsolAta = getAssociatedTokenAddressSync(WSOL_MINT, buyer, false, TOKEN_PROGRAM_ID);

        const ixs: TransactionInstruction[] = [];
        ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
        ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }));

        // 5. WSOL: create ATA + transfer SOL + sync
        const wsolInfo = await conn.getAccountInfo(userWsolAta);
        if (!wsolInfo) {
            ixs.push(createAssociatedTokenAccountInstruction(buyer, userWsolAta, buyer, WSOL_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
        }
        // Transfer SOL to WSOL ATA (with 10% buffer for fees)
        ixs.push(new TransactionInstruction({
            programId: SystemProgram.programId,
            keys: [
                { pubkey: buyer, isSigner: true, isWritable: true },
                { pubkey: userWsolAta, isSigner: false, isWritable: true },
            ],
            data: (() => {
                const buf = Buffer.allocUnsafe(12);
                buf.writeUInt32LE(2, 0); // Transfer instruction index
                buf.writeBigUInt64LE(BigInt(Math.floor(solLamports * 1.1)), 4);
                return buf;
            })(),
        }));
        ixs.push(createSyncNativeInstruction(userWsolAta, TOKEN_PROGRAM_ID));

        // 6. Create base token ATA if needed
        const baseAtaInfo = await conn.getAccountInfo(userBaseAta);
        if (!baseAtaInfo) {
            ixs.push(createAssociatedTokenAccountInstruction(buyer, userBaseAta, buyer, mint, tokenProg, ASSOCIATED_TOKEN_PROGRAM_ID));
        }

        // 7. Build buy instruction data: disc(8) + base_amount_out(8) + max_sol_input(8) + track_volume(1)
        const data = Buffer.allocUnsafe(25);
        BUY_DISC.copy(data, 0);
        data.writeBigUInt64LE(BigInt(baseAmountOut), 8);
        data.writeBigUInt64LE(BigInt(maxSolInput), 16);
        data[24] = 1; // VOLUME_TRACKING_ENABLED

        ixs.push(new TransactionInstruction({
            programId: PUMP_AMM_PROGRAM,
            data,
            keys: [
                { pubkey: poolKey, isSigner: false, isWritable: true }, // 0: pool
                { pubkey: buyer, isSigner: true, isWritable: true }, // 1: user
                { pubkey: PUMP_AMM_GLOBAL_CFG, isSigner: false, isWritable: false }, // 2: globalConfig
                { pubkey: mint, isSigner: false, isWritable: false }, // 3: baseMint
                { pubkey: WSOL_MINT, isSigner: false, isWritable: false }, // 4: quoteMint
                { pubkey: userBaseAta, isSigner: false, isWritable: true }, // 5: userBaseTokenAccount
                { pubkey: userWsolAta, isSigner: false, isWritable: true }, // 6: userQuoteTokenAccount
                { pubkey: new PublicKey(pool.poolBaseTokenAccount), isSigner: false, isWritable: true }, // 7: poolBaseTokenAccount
                { pubkey: new PublicKey(pool.poolQuoteTokenAccount), isSigner: false, isWritable: true }, // 8: poolQuoteTokenAccount
                { pubkey: feeRecipient, isSigner: false, isWritable: false }, // 9: feeRecipient
                { pubkey: feeRecipientTokenAcct, isSigner: false, isWritable: true }, // 10: feeRecipientTokenAccount
                { pubkey: tokenProg, isSigner: false, isWritable: false }, // 11: baseTokenProgram
                { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // 12: quoteTokenProgram
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // 13: systemProgram
                { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // 14: associatedTokenProgram
                { pubkey: PUMP_AMM_EVENT_AUTH, isSigner: false, isWritable: false }, // 15: eventAuthority
                { pubkey: PUMP_AMM_PROGRAM, isSigner: false, isWritable: false }, // 16: program
                { pubkey: creatorVaultAta, isSigner: false, isWritable: true }, // 17: coinCreatorVaultAta
                { pubkey: creatorVaultAuth, isSigner: false, isWritable: false }, // 18: coinCreatorVaultAuthority
                { pubkey: globalVolAcc, isSigner: false, isWritable: false }, // 19: globalVolumeAccumulator
                { pubkey: userVolAcc, isSigner: false, isWritable: true }, // 20: userVolumeAccumulator
                { pubkey: feeConfig, isSigner: false, isWritable: false }, // 21: feeConfig
                { pubkey: PUMP_AMM_FEE_PROG, isSigner: false, isWritable: false }, // 22: feeProgram
            ],
        }));

        // 8. Close WSOL ATA afterwards (unwrap remaining SOL)
        ixs.push(createCloseAccountInstruction(userWsolAta, buyer, buyer, [], TOKEN_PROGRAM_ID));

        const { blockhash } = await conn.getLatestBlockhash('confirmed');
        const msg = new TransactionMessage({ payerKey: buyer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
        const transaction = new VersionedTransaction(msg);

        console.log(`📊 PumpSwap buy: ~${tokensOutExpected.toFixed(0)} tokens for ${amountSol} SOL (pool: ${poolAddr.slice(0, 8)}...)`);

        return {
            transaction,
            quote: {
                tokensOut: tokensOutExpected,
                minTokensOut: tokensOutExpected * (1 - slippageBps / 10000),
                pricePerToken,
                poolAddress: poolAddr,
            },
        };
    }

    /**
     * Sell a graduated token via PumpSwap pAMM.
     */
    async sellPumpSwap(
        tokenMint: string,
        tokenAmount: number,
        slippageBps: number,
        walletPublicKey: string,
    ): Promise<{ transaction: VersionedTransaction; quote: any } | null> {
        const mint = new PublicKey(tokenMint);
        const seller = new PublicKey(walletPublicKey);
        const conn = this.connection;

        const poolAddr = await this.findPoolByMint(tokenMint);
        if (!poolAddr) throw new Error(`No pAMM pool for ${tokenMint}`);

        const pool = await this.getPoolData(poolAddr);
        if (!pool) throw new Error(`Could not read pool data for ${poolAddr}`);

        const { pricePerToken } = await this.getPoolPrice(pool);
        const solOutExpected = tokenAmount * pricePerToken;
        const tokenDecimals = 6;
        const baseAmountIn = Math.floor(tokenAmount * 10 ** tokenDecimals);
        const minSolOut = Math.floor(solOutExpected * (1 - slippageBps / 10000) * 1e9);

        const mintInfo = await conn.getAccountInfo(mint);
        const tokenProg = mintInfo?.owner.toBase58() === TOKEN_2022.toBase58() ? TOKEN_2022 : TOKEN_PROGRAM_ID;
        const feeRecipient = await this.getFeeRecipient(pool.isMayhemMode);
        const feeRecipientTokenAcct = getAssociatedTokenAddressSync(WSOL_MINT, feeRecipient, true, TOKEN_PROGRAM_ID);

        const poolKey = new PublicKey(poolAddr);
        const coinCreator = new PublicKey(pool.coinCreator);
        const creatorVaultAuth = PumpSwapService.coinCreatorVault(coinCreator);
        const creatorVaultAta = getAssociatedTokenAddressSync(WSOL_MINT, creatorVaultAuth, true, TOKEN_PROGRAM_ID);
        const globalVolAcc = PumpSwapService.globalVolumeAcc();
        const userVolAcc = PumpSwapService.userVolumeAcc(seller);
        const feeConfig = PumpSwapService.feeConfigPda();
        const userBaseAta = getAssociatedTokenAddressSync(mint, seller, false, tokenProg);
        const userWsolAta = getAssociatedTokenAddressSync(WSOL_MINT, seller, false, TOKEN_PROGRAM_ID);

        const ixs: TransactionInstruction[] = [];
        ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
        ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }));

        // Create WSOL ATA if needed (to receive SOL)
        const wsolInfo = await conn.getAccountInfo(userWsolAta);
        if (!wsolInfo) {
            ixs.push(createAssociatedTokenAccountInstruction(seller, userWsolAta, seller, WSOL_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
        }

        const data = Buffer.allocUnsafe(25);
        SELL_DISC.copy(data, 0);
        data.writeBigUInt64LE(BigInt(baseAmountIn), 8);
        data.writeBigUInt64LE(BigInt(minSolOut), 16);
        data[24] = 1;

        ixs.push(new TransactionInstruction({
            programId: PUMP_AMM_PROGRAM,
            data,
            keys: [
                { pubkey: poolKey, isSigner: false, isWritable: true },
                { pubkey: seller, isSigner: true, isWritable: true },
                { pubkey: PUMP_AMM_GLOBAL_CFG, isSigner: false, isWritable: false },
                { pubkey: mint, isSigner: false, isWritable: false },
                { pubkey: WSOL_MINT, isSigner: false, isWritable: false },
                { pubkey: userBaseAta, isSigner: false, isWritable: true },
                { pubkey: userWsolAta, isSigner: false, isWritable: true },
                { pubkey: new PublicKey(pool.poolBaseTokenAccount), isSigner: false, isWritable: true },
                { pubkey: new PublicKey(pool.poolQuoteTokenAccount), isSigner: false, isWritable: true },
                { pubkey: feeRecipient, isSigner: false, isWritable: false },
                { pubkey: feeRecipientTokenAcct, isSigner: false, isWritable: true },
                { pubkey: tokenProg, isSigner: false, isWritable: false },
                { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                { pubkey: PUMP_AMM_EVENT_AUTH, isSigner: false, isWritable: false },
                { pubkey: PUMP_AMM_PROGRAM, isSigner: false, isWritable: false },
                { pubkey: creatorVaultAta, isSigner: false, isWritable: true },
                { pubkey: creatorVaultAuth, isSigner: false, isWritable: false },
                { pubkey: globalVolAcc, isSigner: false, isWritable: false },
                { pubkey: userVolAcc, isSigner: false, isWritable: true },
                { pubkey: feeConfig, isSigner: false, isWritable: false },
                { pubkey: PUMP_AMM_FEE_PROG, isSigner: false, isWritable: false },
            ],
        }));

        // Close WSOL ATA to reclaim SOL
        ixs.push(createCloseAccountInstruction(userWsolAta, seller, seller, [], TOKEN_PROGRAM_ID));

        const { blockhash } = await conn.getLatestBlockhash('confirmed');
        const msg = new TransactionMessage({ payerKey: seller, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
        const transaction = new VersionedTransaction(msg);

        return { transaction, quote: { solOut: solOutExpected, minSolOut: minSolOut / 1e9, pricePerToken } };
    }
}
