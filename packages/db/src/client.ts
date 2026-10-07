import pg from "pg";

// Return NUMERIC and BIGINT as JS numbers. Prices fit comfortably in a double,
// and ids/counts stay well under 2^53.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v == null ? null : Number(v)));
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v == null ? null : Number(v)));

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export interface PoolOptions {
  connectionString?: string;
  max?: number;
  applicationName?: string;
  /** Per-statement timeout in ms. Keep it short for the web app. */
  statementTimeoutMs?: number;
}

export function createPool(opts: PoolOptions = {}): pg.Pool {
  const connectionString = opts.connectionString;
  if (!connectionString) {
    throw new Error("No database connection string. Set DATABASE_URL (web) or INGEST_DATABASE_URL (ingest).");
  }
  return new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    application_name: opts.applicationName ?? "decode-health",
    statement_timeout: opts.statementTimeoutMs,
  });
}

/** Writer pool for migrations and ingest. */
export function createIngestPool(): pg.Pool {
  return createPool({
    connectionString: process.env.INGEST_DATABASE_URL ?? process.env.DATABASE_URL,
    max: 4,
    applicationName: "decode-health-ingest",
  });
}

export async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Quote an identifier we generated ourselves (partition names). Never pass user input here. */
export function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Refusing unsafe identifier: ${name}`);
  return `"${name}"`;
}
