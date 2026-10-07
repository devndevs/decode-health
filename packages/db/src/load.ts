/**
 * Bulk loading and summarizing.
 *
 * loadWorkDir() takes the output of the parser and swaps it in as a hospital's
 * current price data:
 *
 *   1. Resolve payer/plan spellings to raw_payer_plans ids (match new ones to payers).
 *   2. CREATE staging tables shaped like the partitioned parents.
 *   3. COPY the CSVs in (streaming — memory use is flat regardless of file size).
 *   4. Build indexes and ANALYZE while nobody is reading the tables.
 *   5. In one short transaction: DETACH the old partitions, ATTACH the new ones,
 *      point hospitals.current_mrf_file_id at the new file.
 *   6. DROP the old partitions.
 *
 * Step 5 holds a brief exclusive lock on the parent tables; lock_timeout makes
 * it fail fast (and the caller can retry) rather than queue behind a slow query.
 */
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { from as copyFrom } from "pg-copy-streams";
import {
  buildPayerIndex,
  inferProductType,
  matchPayer,
  normalizeName,
  SHOPPABLE_CODE_TYPES,
  type PayerIndex,
} from "@decode-health/core";
import { ident, withTransaction, type Pool, type PoolClient } from "./client";
import { PAYER_PLANS_FILE, WORK_FILES, type PayerPlanEntry } from "./work-files";

const FACT_TABLES = ["charge_items", "charge_item_codes", "charge_rates"] as const;
type FactTable = (typeof FACT_TABLES)[number];

export function partitionName(table: FactTable, hospitalId: number, mrfFileId: number): string {
  return `${table}_h${hospitalId}_f${mrfFileId}`;
}

// ---------------------------------------------------------------------------
// Payer plans
// ---------------------------------------------------------------------------

export async function loadPayerIndex(c: PoolClient | Pool): Promise<{ index: PayerIndex; idBySlug: Map<string, number> }> {
  const { rows } = await c.query<{ id: number; slug: string; alias: string; prefix_match: boolean }>(
    "SELECT p.id, p.slug, p.prefix_match, a.alias FROM payers p JOIN payer_aliases a ON a.payer_id = p.id",
  );
  const bySlug = new Map<string, { slug: string; name: string; aliases: string[]; prefixMatch: boolean }>();
  const idBySlug = new Map<string, number>();
  for (const r of rows) {
    idBySlug.set(r.slug, r.id);
    const entry = bySlug.get(r.slug) ?? { slug: r.slug, name: r.slug, aliases: [], prefixMatch: r.prefix_match };
    entry.aliases.push(r.alias);
    bySlug.set(r.slug, entry);
  }
  return { index: buildPayerIndex([...bySlug.values()]), idBySlug };
}

function resolvePayerPlan(payerName: string, planName: string, idx: { index: PayerIndex; idBySlug: Map<string, number> }) {
  const match = matchPayer(payerName, idx.index);
  return {
    payerId: match ? (idx.idBySlug.get(match.slug) ?? null) : null,
    method: match?.method ?? null,
    productType: inferProductType(planName, payerName),
  };
}

/** Upsert the file's distinct payer/plan spellings; return local id → raw_payer_plans.id. */
export async function upsertPayerPlans(c: PoolClient, entries: PayerPlanEntry[]): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  if (!entries.length) return map;

  const idx = await loadPayerIndex(c);
  const byKey = new Map<string, { payerName: string; planName: string; payerKey: string; planKey: string; locals: number[] }>();
  for (const [local, payerName, planName] of entries) {
    const payerKey = normalizeName(payerName);
    const planKey = normalizeName(planName);
    const k = `${payerKey}\u0000${planKey}`;
    const e = byKey.get(k) ?? { payerName, planName, payerKey, planKey, locals: [] };
    e.locals.push(local);
    byKey.set(k, e);
  }
  const rows = [...byKey.values()].map((e) => ({ ...e, ...resolvePayerPlan(e.payerName, e.planName, idx) }));

  await c.query(
    `INSERT INTO raw_payer_plans (payer_name, plan_name, payer_key, plan_key, payer_id, match_method, product_type)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::int[], $6::text[], $7::text[])
     ON CONFLICT (payer_key, plan_key) DO NOTHING`,
    [
      rows.map((r) => r.payerName),
      rows.map((r) => r.planName),
      rows.map((r) => r.payerKey),
      rows.map((r) => r.planKey),
      rows.map((r) => r.payerId),
      rows.map((r) => r.method),
      rows.map((r) => r.productType),
    ],
  );
  const { rows: ids } = await c.query<{ id: number; payer_key: string; plan_key: string }>(
    `SELECT id, payer_key, plan_key FROM raw_payer_plans
     WHERE (payer_key, plan_key) IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
    [rows.map((r) => r.payerKey), rows.map((r) => r.planKey)],
  );
  const idByKey = new Map(ids.map((r) => [`${r.payer_key}\u0000${r.plan_key}`, r.id]));
  for (const [k, e] of byKey) {
    const id = idByKey.get(k);
    if (id == null) throw new Error(`raw_payer_plans row missing after upsert: ${e.payerName} / ${e.planName}`);
    for (const local of e.locals) map.set(local, id);
  }
  return map;
}

/**
 * Re-run payer matching over every stored spelling (except manual overrides).
 * Run after editing data/payers/payers.json + registry:sync, then re-summarize.
 */
export async function rematchPayerPlans(pool: Pool): Promise<{ checked: number; changed: number }> {
  return withTransaction(pool, async (c) => {
    const idx = await loadPayerIndex(c);
    const { rows } = await c.query<{
      id: number;
      payer_name: string;
      plan_name: string;
      payer_id: number | null;
      match_method: string | null;
      product_type: string;
    }>("SELECT id, payer_name, plan_name, payer_id, match_method, product_type FROM raw_payer_plans WHERE match_method IS DISTINCT FROM 'manual'");
    let changed = 0;
    for (const r of rows) {
      const next = resolvePayerPlan(r.payer_name, r.plan_name, idx);
      if (next.payerId !== r.payer_id || next.method !== r.match_method || next.productType !== r.product_type) {
        await c.query("UPDATE raw_payer_plans SET payer_id = $2, match_method = $3, product_type = $4 WHERE id = $1", [
          r.id,
          next.payerId,
          next.method,
          next.productType,
        ]);
        changed++;
      }
    }
    return { checked: rows.length, changed };
  });
}

// ---------------------------------------------------------------------------
// COPY helpers
// ---------------------------------------------------------------------------

async function copyCsv(c: PoolClient, table: string, columns: readonly string[], file: string, transform?: Transform) {
  const sql = `COPY ${ident(table)} (${columns.map(ident).join(", ")}) FROM STDIN WITH (FORMAT csv, HEADER MATCH)`;
  const sink = c.query(copyFrom(sql));
  const source = createReadStream(file);
  if (transform) await pipeline(source, transform, sink);
  else await pipeline(source, sink);
}

/** Rewrites the first column of each line (local payer-plan id → global id). Header passes through. */
class RemapFirstColumn extends Transform {
  private buf = "";
  private header = true;
  constructor(private readonly ids: Map<number, number>) {
    super();
  }
  private line(line: string): string {
    if (this.header) {
      this.header = false;
      return line;
    }
    const comma = line.indexOf(",");
    const local = Number(line.slice(0, comma));
    const global = this.ids.get(local);
    if (global == null) throw new Error(`rates.csv references unknown payer plan ${local}`);
    return global + line.slice(comma);
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
    try {
      this.buf += chunk.toString("utf8");
      const lines = this.buf.split("\n");
      this.buf = lines.pop() ?? "";
      if (lines.length) this.push(lines.map((l) => this.line(l)).join("\n") + "\n");
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }
  override _flush(cb: TransformCallback) {
    try {
      if (this.buf) this.push(this.line(this.buf) + "\n");
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }
}

async function currentPartitions(c: PoolClient, hospitalId: number): Promise<Map<FactTable, string>> {
  const { rows } = await c.query<{ parent: FactTable; child: string }>(
    `SELECT p.relname AS parent, ch.relname AS child
     FROM pg_inherits i
     JOIN pg_class ch ON ch.oid = i.inhrelid
     JOIN pg_class p ON p.oid = i.inhparent
     WHERE p.relname = ANY($1::text[]) AND pg_get_expr(ch.relpartbound, ch.oid) = $2`,
    [FACT_TABLES, `FOR VALUES IN (${hospitalId})`],
  );
  return new Map(rows.map((r) => [r.parent, r.child]));
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

export interface LoadResult {
  hospitalId: number;
  mrfFileId: number;
  replaced: string[];
  ms: number;
}

export async function loadWorkDir(
  pool: Pool,
  opts: { hospitalId: number; mrfFileId: number; workDir: string; log?: (m: string) => void },
): Promise<LoadResult> {
  const { hospitalId, mrfFileId, workDir } = opts;
  const log = opts.log ?? (() => {});
  if (!Number.isInteger(hospitalId) || !Number.isInteger(mrfFileId)) throw new Error("hospitalId and mrfFileId must be integers");
  const started = Date.now();
  const staged = Object.fromEntries(FACT_TABLES.map((t) => [t, partitionName(t, hospitalId, mrfFileId)])) as Record<FactTable, string>;

  const c = await pool.connect();
  try {
    const entries = JSON.parse(await readFile(path.join(workDir, PAYER_PLANS_FILE), "utf8")) as PayerPlanEntry[];
    const payerPlanIds = await upsertPayerPlans(c, entries);
    log(`resolved ${entries.length} payer/plan spellings`);

    for (const t of FACT_TABLES) {
      const n = ident(staged[t]);
      await c.query(`DROP TABLE IF EXISTS ${n}`);
      await c.query(`CREATE TABLE ${n} (LIKE ${ident(t)} INCLUDING DEFAULTS)`);
      await c.query(`ALTER TABLE ${n} ALTER COLUMN hospital_id SET DEFAULT ${hospitalId}`);
      // Lets ATTACH PARTITION skip its validation scan.
      await c.query(`ALTER TABLE ${n} ADD CONSTRAINT ${ident(`${staged[t]}_chk`)} CHECK (hospital_id = ${hospitalId})`);
    }
    await c.query(`ALTER TABLE ${ident(staged.charge_items)} ALTER COLUMN mrf_file_id SET DEFAULT ${mrfFileId}`);

    await copyCsv(c, staged.charge_items, WORK_FILES.items.columns, path.join(workDir, WORK_FILES.items.file));
    await copyCsv(c, staged.charge_item_codes, WORK_FILES.codes.columns, path.join(workDir, WORK_FILES.codes.file));
    await copyCsv(
      c,
      staged.charge_rates,
      WORK_FILES.rates.columns,
      path.join(workDir, WORK_FILES.rates.file),
      new RemapFirstColumn(payerPlanIds),
    );
    log("copied rows into staging tables");

    // Same definitions as the parent's partitioned indexes, so ATTACH adopts them instead of rebuilding.
    await c.query(`ALTER TABLE ${ident(staged.charge_items)} ADD PRIMARY KEY (hospital_id, item_id)`);
    await c.query(`CREATE INDEX ON ${ident(staged.charge_item_codes)} (code_type, code, item_id)`);
    await c.query(`CREATE INDEX ON ${ident(staged.charge_item_codes)} (item_id)`);
    await c.query(`CREATE INDEX ON ${ident(staged.charge_rates)} (item_id, payer_plan_id)`);
    await c.query(`CREATE INDEX ON ${ident(staged.charge_rates)} (payer_plan_id)`);
    for (const t of FACT_TABLES) await c.query(`ANALYZE ${ident(staged[t])}`);
    log("indexed and analyzed");

    await c.query("BEGIN");
    await c.query("SET LOCAL lock_timeout = '15s'");
    const old = await currentPartitions(c, hospitalId);
    for (const t of FACT_TABLES) {
      const prev = old.get(t);
      if (prev && prev !== staged[t]) await c.query(`ALTER TABLE ${ident(t)} DETACH PARTITION ${ident(prev)}`);
      if (prev !== staged[t]) {
        await c.query(`ALTER TABLE ${ident(t)} ATTACH PARTITION ${ident(staged[t])} FOR VALUES IN (${hospitalId})`);
      }
    }
    await c.query("UPDATE hospitals SET current_mrf_file_id = $2, updated_at = now() WHERE id = $1", [hospitalId, mrfFileId]);
    await c.query(
      "UPDATE mrf_files SET status = 'superseded' WHERE hospital_id = $1 AND status = 'loaded' AND id <> $2",
      [hospitalId, mrfFileId],
    );
    await c.query("UPDATE mrf_files SET status = 'loaded', loaded_at = now(), error = NULL WHERE id = $1", [mrfFileId]);
    await c.query("COMMIT");

    const replaced = [...old.values()].filter((n) => !Object.values(staged).includes(n));
    for (const n of replaced) await c.query(`DROP TABLE IF EXISTS ${ident(n)}`);
    log(`swapped in file ${mrfFileId}${replaced.length ? `, dropped ${replaced.length} old partition(s)` : ""}`);

    return { hospitalId, mrfFileId, replaced, ms: Date.now() - started };
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    // Leave nothing half-built behind. Attached partitions are untouched because the swap rolled back.
    const attached = await currentPartitions(c, hospitalId).catch(() => new Map<FactTable, string>());
    for (const t of FACT_TABLES) {
      if (attached.get(t) !== staged[t]) await c.query(`DROP TABLE IF EXISTS ${ident(staged[t])}`).catch(() => {});
    }
    throw err;
  } finally {
    c.release();
  }
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

const PERCENTILES = `
  count(*)::int,
  min(amount),
  percentile_cont(0.25) WITHIN GROUP (ORDER BY amount),
  percentile_cont(0.5)  WITHIN GROUP (ORDER BY amount),
  percentile_cont(0.75) WITHIN GROUP (ORDER BY amount),
  max(amount)`;

/**
 * Rebuild price_summary for one hospital from its current partition.
 * Only base prices (no modifiers) for shoppable code types are summarized.
 */
export async function summarizeHospital(pool: Pool, hospitalId: number): Promise<number> {
  return withTransaction(pool, async (c) => {
    await c.query("DELETE FROM price_summary WHERE hospital_id = $1", [hospitalId]);

    const itemLevel = await c.query(
      `INSERT INTO price_summary (hospital_id, code_type, code, setting, billing_class, scope, n, min, p25, median, p75, max)
       SELECT $1, c.code_type, c.code, COALESCE(i.setting, 'unknown'), COALESCE(i.billing_class, 'unknown'), s.scope, ${PERCENTILES}
       FROM charge_item_codes c
       JOIN charge_items i ON i.hospital_id = c.hospital_id AND i.item_id = c.item_id
       CROSS JOIN LATERAL (VALUES ('cash', i.discounted_cash), ('gross', i.gross)) AS s(scope, amount)
       WHERE c.hospital_id = $1 AND c.code_type = ANY($2::text[])
         AND cardinality(i.modifiers) = 0 AND s.amount IS NOT NULL
       GROUP BY c.code_type, c.code, 4, 5, s.scope`,
      [hospitalId, SHOPPABLE_CODE_TYPES],
    );

    const rateLevel = await c.query(
      `INSERT INTO price_summary (hospital_id, code_type, code, setting, billing_class, scope, payer_id, product_type, n, min, p25, median, p75, max)
       SELECT $1, c.code_type, c.code, COALESCE(i.setting, 'unknown'), COALESCE(i.billing_class, 'unknown'),
              g.scope, g.payer_id, g.product_type, ${PERCENTILES}
       FROM charge_item_codes c
       JOIN charge_items i ON i.hospital_id = c.hospital_id AND i.item_id = c.item_id
       JOIN charge_rates r ON r.hospital_id = c.hospital_id AND r.item_id = c.item_id
       JOIN raw_payer_plans pp ON pp.id = r.payer_plan_id
       CROSS JOIN LATERAL (VALUES
         ('all_payers', 0, ''),
         ('payer', COALESCE(pp.payer_id, -1), ''),
         ('payer_product', COALESCE(pp.payer_id, -1), pp.product_type)
       ) AS g(scope, payer_id, product_type)
       CROSS JOIN LATERAL (SELECT r.effective_amount AS amount) a
       WHERE c.hospital_id = $1 AND c.code_type = ANY($2::text[])
         AND cardinality(i.modifiers) = 0 AND r.effective_amount IS NOT NULL
         AND (g.scope = 'all_payers' OR pp.payer_id IS NOT NULL)
       GROUP BY c.code_type, c.code, 4, 5, g.scope, g.payer_id, g.product_type`,
      [hospitalId, SHOPPABLE_CODE_TYPES],
    );

    return (itemLevel.rowCount ?? 0) + (rateLevel.rowCount ?? 0);
  });
}

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

/** Drop a hospital's partitions, summaries, file history, and registry row. */
export async function removeHospitalData(pool: Pool, hospitalId: number): Promise<void> {
  await withTransaction(pool, async (c) => {
    const parts = await currentPartitions(c, hospitalId);
    for (const [table, partition] of parts) {
      await c.query(`ALTER TABLE ${ident(table)} DETACH PARTITION ${ident(partition)}`);
      await c.query(`DROP TABLE ${ident(partition)}`);
    }
    await c.query("UPDATE hospitals SET current_mrf_file_id = NULL WHERE id = $1", [hospitalId]);
    await c.query("DELETE FROM price_summary WHERE hospital_id = $1", [hospitalId]);
    await c.query("DELETE FROM mrf_files WHERE hospital_id = $1", [hospitalId]);
    await c.query("DELETE FROM hospitals WHERE id = $1", [hospitalId]);
  });
}
