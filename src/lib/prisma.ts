import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// In the packaged app the launcher sets DATABASE_URL to the user's writable data
// dir. Provide a sane fallback for dev/tooling so the schema's env("DATABASE_URL")
// always resolves and we never silently fall back to a read-only relative path.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'file:./prisma/sqlite/data.db';
}

export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  // Bind explicitly to the resolved URL so the runtime never depends on relative
  // path resolution (the cause of the Program Files SQLITE_CANTOPEN bug).
  datasourceUrl: process.env.DATABASE_URL,
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : [],
  transactionOptions: {
    maxWait: 2000,
    timeout: 5000,
  },
});

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

/**
 * Idempotent in-place migrations that `prisma db push` cannot express as renames.
 * Runs once at startup, before any queries. Safe on fresh DBs (columns already correct).
 */
let migrationsSettled = false;
async function runStartupMigrations() {
  try {
    const cols: Array<{ name: string }> = await prisma.$queryRawUnsafe(
      `PRAGMA table_info('snipe_settings')`
    );
    const names = cols.map(c => c.name);
    if (names.includes('minLiquiditySol') && !names.includes('minLiquidityUsd')) {
      await prisma.$executeRawUnsafe(`ALTER TABLE snipe_settings RENAME COLUMN minLiquiditySol TO minLiquidityUsd`);
      await prisma.$executeRawUnsafe(`ALTER TABLE snipe_settings RENAME COLUMN maxLiquiditySol TO maxLiquidityUsd`);
      console.log('✅ Migrated snipe_settings: minLiquiditySol/maxLiquiditySol → minLiquidityUsd/maxLiquidityUsd');
    }
    // Momentum max-change bounds (2026-06-12): upper bound per timeframe so momentum
    // can express ranges (gains-only, cap over-pumped entries, or dip-buy windows).
    for (const col of ['maxChange5m', 'maxChange1h', 'maxChange24h']) {
      if (!names.includes(col)) {
        await prisma.$executeRawUnsafe(`ALTER TABLE snipe_settings ADD COLUMN ${col} REAL`);
        console.log(`✅ Migrated snipe_settings: added ${col}`);
      }
    }
    // DEX identifier unification (audit §6.1) — normalize legacy values in place.
    const dexFixes: Array<[string, string]> = [
      ['pump.fun', 'pumpfun'], ['bonkisfun', 'launchlab'], ['letsbonk', 'launchlab'],
      ['raydium_amm', 'raydium'], ['raydium_clmm', 'raydium'],
    ];
    for (const table of ['Token', 'transactions', 'snipe_executions']) {
      for (const [oldId, newId] of dexFixes) {
        await prisma.$executeRawUnsafe(
          `UPDATE ${table} SET dex='${newId}' WHERE LOWER(dex)='${oldId}'`
        ).catch(() => { /* table/column may not exist — fine */ });
      }
    }
  } catch (e: any) {
    console.warn('Startup migration check failed (non-fatal):', e?.message);
  } finally {
    migrationsSettled = true;
  }
}
export const startupMigrations = runStartupMigrations();

// Gate all queries on startup migrations so no query can race the column rename.
// (The migration's own raw queries bypass via the migrationsSettled flag pattern:
// raw queries from inside runStartupMigrations run while migrationsSettled is false
// AND are the only queries in flight at module-init time, so they must not await.)
prisma.$use(async (params, next) => {
  if (!migrationsSettled && (params.action === 'queryRaw' || params.action === 'executeRaw')) {
    return next(params); // migration's own statements — don't gate
  }
  await startupMigrations;
  return next(params);
});

// Log slow queries
prisma.$use(async (params, next) => {
  const start = Date.now();
  const result = await next(params);
  const duration = Date.now() - start;

  if (duration > 1000) {
    console.warn(`🐌 SLOW QUERY: ${params.model}.${params.action} took ${duration}ms`);
  } else if (duration > 500) {
    console.log(`⚡ Query: ${params.model}.${params.action} took ${duration}ms`);
  }

  return result;
});
