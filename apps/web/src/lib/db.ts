/**
 * Read-only database access for server components.
 *
 * Connects as the read-only role (DATABASE_URL). If the database is not
 * configured or unreachable, queries return null and pages show a friendly
 * "data unavailable" message instead of crashing.
 */
import "server-only";
import { createPool, type Pool } from "@decode-health/db";

const globalForPool = globalThis as unknown as { decodePool?: Pool };

function pool(): Pool | null {
  if (!process.env.DATABASE_URL) return null;
  globalForPool.decodePool ??= createPool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    statementTimeoutMs: 5_000,
    applicationName: "decode-health-web",
  });
  return globalForPool.decodePool;
}

export async function withDb<T>(fn: (pool: Pool) => Promise<T>): Promise<T | null> {
  const p = pool();
  if (!p) return null;
  try {
    return await fn(p);
  } catch (err) {
    console.error("[db]", (err as Error).message);
    return null;
  }
}
