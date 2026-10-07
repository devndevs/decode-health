/**
 * Ingest command line. Run from the repo root:
 *
 *   pnpm ingest <command> [options]
 *
 * Commands
 *   registry:check                     Validate everything in /data (no database needed)
 *   registry:sync                      Upsert /data into Postgres
 *   validate <file|dir>... [--out <dir>]  Parse a hospital file (all parts) offline and print a report
 *   discover  [--hospital s|--region s] Find file URLs from each hospital's cms-hpt.txt
 *   run       [--hospital s|--region s] Discover → download → parse → load → summarize
 *             [--force] [--rediscover] [--keep-work] [--concurrency n]
 *   load-file --hospital s <file|dir>... Ingest file(s) you downloaded by hand; a directory = all its parts
 *   summarize [--hospital s|--region s] Rebuild price summaries
 *   payers:unmatched [--limit n]        Payer/plan spellings that need an alias
 *   payers:rematch                      Re-run payer matching after editing aliases
 *   status    [--region s]              What's loaded, and how fresh it is
 *   hospital:remove --hospital s --yes  Delete a hospital and all of its price data
 *   demo:seed                           Load synthetic fixtures as a fake "Sample Hospital" (dev only)
 */
import { readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseArgs } from "node:util";
import { createIngestPool, ingestTargets, unmatchedPayerPlans, type HospitalIngestTarget, type Pool } from "@decode-health/db";
import { rematchPayerPlans, removeHospitalData, summarizeHospital } from "@decode-health/db/load";
import { migrate } from "@decode-health/db/migrate";
import { loadRegistry, syncRegistry, RegistryError } from "@decode-health/db/registry";
import { parseMrfFile } from "./parsers";
import { discoverHospital, ingestHospital, ingestLocalFile, type IngestContext } from "./pipeline";
import { storageFromEnv } from "./storage";
import { writeWorkDir } from "./writer";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const REGISTRY_DIR = path.join(REPO_ROOT, "data");
const DATA_DIR = path.resolve(REPO_ROOT, process.env.DATA_DIR ?? ".data");

const { positionals, values: args } = parseArgs({
  allowPositionals: true,
  options: {
    hospital: { type: "string" },
    region: { type: "string" },
    file: { type: "string", multiple: true },
    out: { type: "string" },
    limit: { type: "string" },
    concurrency: { type: "string" },
    force: { type: "boolean", default: false },
    rediscover: { type: "boolean", default: false },
    "keep-work": { type: "boolean", default: false },
    all: { type: "boolean", default: false },
    yes: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const [command, ...rest] = positionals;
const log = (msg: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

function context(pool: Pool): IngestContext {
  return {
    pool,
    storage: storageFromEnv(DATA_DIR),
    dataDir: DATA_DIR,
    userAgent: process.env.INGEST_USER_AGENT ?? "DecodeHealthBot/0.1",
    maxBytes: Number(process.env.INGEST_MAX_FILE_BYTES ?? 20 * 1024 ** 3),
    maxUncompressedBytes: Number(process.env.INGEST_MAX_UNCOMPRESSED_BYTES ?? 100 * 1024 ** 3),
    log,
  };
}

async function targets(pool: Pool): Promise<HospitalIngestTarget[]> {
  if (!args.hospital && !args.region && !args.all) {
    throw new Error("Pass --hospital <slug>, --region <slug>, or --all");
  }
  const list = await ingestTargets(pool, { hospital: args.hospital, region: args.region });
  if (!list.length) throw new Error("No hospitals matched. Did you run `pnpm ingest registry:sync`?");
  return list;
}

/**
 * Files from positionals and --file. A directory expands to its data files in
 * natural order (part-2 before part-10), which is how multi-part files are passed.
 */
async function inputFiles(): Promise<string[]> {
  const out: string[] = [];
  for (const p of [...rest, ...(args.file ?? [])].map((f) => path.resolve(f))) {
    if ((await stat(p)).isDirectory()) {
      const names = (await readdir(p)).filter((n) => /\.(csv|json|zip|gz)$/i.test(n));
      names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      out.push(...names.map((n) => path.join(p, n)));
    } else out.push(p);
  }
  return out;
}

/** Run `fn` over items with bounded concurrency; collect failures instead of stopping. */
async function each<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  const failures: Array<{ item: T; error: Error }> = [];
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const item = items[i++]!;
      try {
        await fn(item);
      } catch (error) {
        failures.push({ item, error: error as Error });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return failures;
}

async function withPool<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = createIngestPool();
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

const commands: Record<string, () => Promise<void>> = {
  async "registry:check"() {
    const reg = await loadRegistry(REGISTRY_DIR);
    log(
      `OK: ${reg.regions.length} regions, ${reg.systems.length} systems, ${reg.hospitals.length} hospitals, ` +
        `${reg.payers.length} payers, ${reg.services.length} services, ${reg.programs.length} programs`,
    );
    const unverified = reg.hospitals.filter((h) => !h.verified).map((h) => h.slug);
    if (unverified.length) log(`Not yet verified: ${unverified.join(", ")}`);
  },

  async "registry:sync"() {
    const reg = await loadRegistry(REGISTRY_DIR);
    await withPool(async (pool) => {
      await migrate(pool, log);
      const r = await syncRegistry(pool, reg);
      log(`Synced ${r.regions} regions, ${r.systems} systems, ${r.hospitals} hospitals, ${r.payers} payers, ${r.services} services`);
      if (r.orphanedHospitals.length) log(`In DB but not in registry (left in place): ${r.orphanedHospitals.join(", ")}`);
      const re = await rematchPayerPlans(pool);
      if (re.changed) log(`Re-matched ${re.changed} payer/plan spelling(s); run \`pnpm ingest summarize --all\` to refresh prices`);
    });
  },

  async validate() {
    const files = await inputFiles();
    if (!files.length) throw new Error("Usage: pnpm ingest validate <file|dir>... [--out <dir>]");
    const out = args.out ?? path.join(DATA_DIR, "validate", path.basename(files[0]!).replace(/\W+/g, "_"));
    const started = Date.now();
    const manifest = await writeWorkDir(
      files.map((f) => () => {
        if (files.length > 1) log(`parsing ${path.basename(f)}`);
        return parseMrfFile(f);
      }),
      out,
      (n) => log(`${n.toLocaleString()} rows…`),
    );
    console.log(JSON.stringify(manifest, null, 2));
    log(`Parsed in ${((Date.now() - started) / 1000).toFixed(1)}s. Work files: ${out}`);
  },

  async discover() {
    await withPool(async (pool) => {
      const ctx = context(pool);
      const failures = await each(await targets(pool), 4, async (h) => {
        if (h.mrf_urls_pinned.length) return log(`${h.slug}: pinned to ${h.mrf_urls_pinned.length} file(s)`);
        await discoverHospital(ctx, h);
      });
      for (const f of failures) console.error(`✗ ${f.item.slug}: ${f.error.message}`);
      if (failures.length) process.exitCode = 1;
    });
  },

  async run() {
    await withPool(async (pool) => {
      const ctx = context(pool);
      const failures = await each(await targets(pool), Number(args.concurrency ?? 2), async (h) => {
        const r = await ingestHospital(ctx, h, { force: args.force, rediscover: args.rediscover, keepWork: args["keep-work"] });
        if (r.status === "unchanged") log(`${h.slug}: unchanged (${r.reason})`);
        else {
          log(`✓ ${h.slug}: loaded file ${r.mrfFileId}`);
          for (const w of r.warnings) log(`  ⚠ ${w}`);
        }
      });
      for (const f of failures) console.error(`✗ ${f.item.slug}: ${f.error.message}`);
      if (failures.length) process.exitCode = 1;
    });
  },

  async "load-file"() {
    const files = await inputFiles();
    if (!args.hospital || !files.length) throw new Error("Usage: pnpm ingest load-file --hospital <slug> <file|dir>...");
    await withPool(async (pool) => {
      const [h] = await targets(pool);
      const r = await ingestLocalFile(context(pool), h!, files, { keepWork: args["keep-work"], force: args.force });
      log(`✓ ${h!.slug}: ${r.status}${r.status === "unchanged" ? ` (${r.reason})` : ""}`);
      if (r.status === "loaded") for (const w of r.warnings) log(`  ⚠ ${w}`);
    });
  },

  async summarize() {
    await withPool(async (pool) => {
      const list = (await targets(pool)).filter((h) => h.current_mrf_file_id != null);
      for (const h of list) log(`${h.slug}: ${(await summarizeHospital(pool, h.id)).toLocaleString()} summary rows`);
    });
  },

  async "payers:unmatched"() {
    await withPool(async (pool) => {
      const rows = await unmatchedPayerPlans(pool, Number(args.limit ?? 50));
      if (!rows.length) return log("Every payer spelling is matched.");
      console.table(rows);
      log("Add the spellings you recognize to `aliases` in data/payers/payers.json, then run registry:sync.");
    });
  },

  async "payers:rematch"() {
    await withPool(async (pool) => {
      const r = await rematchPayerPlans(pool);
      log(`Checked ${r.checked}, changed ${r.changed}. Run \`pnpm ingest summarize --all\` if anything changed.`);
    });
  },

  async status() {
    await withPool(async (pool) => {
      const { rows } = await pool.query(
        `SELECT h.slug, f.status, f.format, f.template_version AS version, to_char(f.last_updated_on, 'YYYY-MM-DD') AS updated,
                pg_size_pretty(f.size_bytes) AS size, (f.stats->>'items')::int AS items, (f.stats->>'rates')::int AS rates,
                to_char(f.loaded_at, 'YYYY-MM-DD HH24:MI') AS loaded_at
         FROM hospitals h
         JOIN regions r ON r.id = h.region_id
         LEFT JOIN mrf_files f ON f.id = h.current_mrf_file_id
         WHERE $1::text IS NULL OR r.path LIKE (SELECT path FROM regions WHERE slug = $1) || '%'
         ORDER BY h.slug`,
        [args.region ?? null],
      );
      console.table(rows);
    });
  },

  async "hospital:remove"() {
    if (!args.hospital) throw new Error("Usage: pnpm ingest hospital:remove --hospital <slug> --yes");
    if (!args.yes) throw new Error(`This deletes ${args.hospital} and all of its price data. Re-run with --yes to confirm.`);
    await withPool(async (pool) => {
      const [h] = await targets(pool);
      await removeHospitalData(pool, h!.id);
      log(`Removed ${h!.slug}. If it is still in data/registry, the next registry:sync will re-create it (without prices).`);
    });
  },

  async "demo:seed"() {
    if (process.env.NODE_ENV === "production") throw new Error("demo:seed is for local development only");
    await withPool(async (pool) => {
      await pool.query(
        `INSERT INTO hospitals (slug, name, region_id, address_line1, city, state, zip, website, location_name_match, verified)
         VALUES ('sample-hospital-demo', 'Sample Hospital (demo data — not real prices)',
                 (SELECT id FROM regions WHERE slug = 'ca-san-diego-county'),
                 '123 Example Way', 'San Diego', 'CA', '92101', 'https://example.org', '{Example General}', false)
         ON CONFLICT (slug) DO NOTHING`,
      );
      const [h] = await ingestTargets(pool, { hospital: "sample-hospital-demo" });
      if (!h) throw new Error("Run `pnpm ingest registry:sync` first so the San Diego region exists");
      const fixture = fileURLToPath(new URL("./fixtures/v3-tall.csv", import.meta.url));
      await ingestLocalFile(context(pool), h, [fixture], { sourceUrl: "fixture://v3-tall.csv", force: true });
      log("✓ Loaded synthetic fixture as 'Sample Hospital'. Remove with: pnpm ingest hospital:remove --hospital sample-hospital-demo --yes");
    });
  },
};

async function main() {
  const fn = command ? commands[command] : undefined;
  if (!fn || args.help) {
    const doc = (await import("node:fs")).readFileSync(fileURLToPath(import.meta.url), "utf8").match(/\/\*\*([\s\S]*?)\*\//)?.[1];
    console.log(doc?.replace(/^ \* ?/gm, "") ?? "Usage: pnpm ingest <command>");
    if (command && !fn) process.exitCode = 1;
    return;
  }
  await fn();
}

main().catch((err) => {
  if (err instanceof RegistryError) console.error(err.message);
  else console.error(err instanceof Error ? (process.env.DEBUG ? err.stack : err.message) : err);
  process.exitCode = 1;
});
