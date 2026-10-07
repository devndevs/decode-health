/**
 * Minimal forward-only migration runner: applies packages/db/migrations/*.sql
 * in filename order, each in its own transaction, and refuses to run if an
 * already-applied file was edited. Plain SQL keeps partitioning and grants
 * explicit — ORMs handle neither well.
 *
 *   pnpm db:migrate
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createIngestPool, type Pool } from "./client";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

export async function migrate(pool: Pool, log: (msg: string) => void = console.log): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('decode-health:migrate'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name        text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);
    const done = new Map<string, string>(
      (await client.query<{ name: string; checksum: string }>("SELECT name, checksum FROM schema_migrations")).rows.map(
        (r) => [r.name, r.checksum],
      ),
    );

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const sql = await readFile(MIGRATIONS_DIR + file, "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const prior = done.get(file);
      if (prior) {
        if (prior !== checksum) throw new Error(`Migration ${file} was modified after being applied. Add a new migration instead.`);
        continue;
      }
      log(`applying ${file}`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [file, checksum]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      applied.push(file);
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('decode-health:migrate'))").catch(() => {});
    client.release();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const pool = createIngestPool();
  migrate(pool)
    .then((applied) => console.log(applied.length ? `Applied ${applied.length} migration(s).` : "Database is up to date."))
    .catch((err) => {
      console.error(err.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
