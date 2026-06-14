/**
 * SQLite Database Client
 * Re-exports the main Prisma client which now points to local SQLite.
 * Kept for backward compatibility with any imports of sqliteDb.
 */
export { prisma as sqliteDb, prisma } from './prisma.js';
export default (await import('./prisma.js')).prisma;
