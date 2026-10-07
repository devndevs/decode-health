/**
 * End-to-end: migrate → registry sync → ingest fixture → summarize → price lookup → estimate.
 *
 * Needs a Postgres 16+ server. Skipped unless TEST_DATABASE_URL points at a
 * database the test can use to CREATE/DROP a throwaway database, e.g.
 *
 *   TEST_DATABASE_URL=postgres://decode:decode@localhost:5432/postgres pnpm test
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { estimateCost } from "@decode-health/core";
import { componentPricing, createPool, getService, ingestTargets, type Pool } from "@decode-health/db";
import { removeHospitalData } from "@decode-health/db/load";
import { migrate } from "@decode-health/db/migrate";
import { loadRegistry, syncRegistry } from "@decode-health/db/registry";
import { ingestLocalFile, type IngestContext } from "./pipeline";
import { LocalStorage } from "./storage";

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const REPO_DATA = fileURLToPath(new URL("../../../data/", import.meta.url));

describe.skipIf(!ADMIN_URL)("ingest → database → estimate", () => {
  const dbName = `decode_it_${Date.now()}`;
  let admin: Pool;
  let pool: Pool;
  let ctx: IngestContext;
  let dataDir: string;
  let hospitalId: number;

  beforeAll(async () => {
    admin = createPool({ connectionString: ADMIN_URL, max: 1 });
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${dbName}`;
    pool = createPool({ connectionString: url.toString(), max: 4 });
    await migrate(pool, () => {});
    await syncRegistry(pool, await loadRegistry(REPO_DATA));

    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO hospitals (slug, name, region_id, address_line1, city, state, zip, website, location_name_match)
       VALUES ('it-hospital', 'Integration Test Hospital', (SELECT id FROM regions WHERE slug = 'ca-san-diego-county'),
               '1 Test Way', 'San Diego', 'CA', '92101', 'https://example.org', '{Example General}')
       RETURNING id`,
    );
    hospitalId = rows[0]!.id;
    dataDir = await mkdtemp(path.join(tmpdir(), "decode-it-"));
    ctx = {
      pool,
      storage: new LocalStorage(dataDir),
      dataDir,
      userAgent: "test",
      maxBytes: 1e9,
      maxUncompressedBytes: 1e9,
      log: () => {},
    };
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.end();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  const target = async () => (await ingestTargets(pool, { hospital: "it-hospital" }))[0]!;

  const partitions = async () =>
    (
      await pool.query<{ part: string }>(
        `SELECT c.relname AS part FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
         JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname IN ('charge_items', 'charge_item_codes', 'charge_rates')
         ORDER BY 1`,
      )
    ).rows.map((r) => r.part);

  it("loads a file and produces plan-level estimates", async () => {
    const r = await ingestLocalFile(ctx, await target(), [fixture("v3-tall.csv")]);
    expect(r.status).toBe("loaded");

    const service = await getService(pool, "office-visit-established");
    const pricing = await componentPricing(pool, {
      hospitalIds: [hospitalId],
      setting: "outpatient",
      payerSlug: "aetna",
      productType: "ppo",
      components: service!.components.map((c) => ({ codeType: c.code_type, code: c.code, billingClass: c.billing_class })),
    });
    const components = pricing.get(hospitalId)!;
    expect(components.map((c) => c.plan?.median)).toEqual([140, 300]); // doctor fee + facility fee (from v3 median allowed)

    const est = estimateCost({
      components,
      coverage: {
        kind: "insured",
        benefits: { deductibleRemaining: 0, deductibleApplies: true, afterDeductible: { type: "coinsurance", percent: 20 }, oopMaxRemaining: null },
      },
    });
    expect(est.allowed).toEqual({ low: 440, typical: 440, high: 440 });
    expect(est.patient).toEqual({ low: 88, typical: 88, high: 88 });
    expect(est.confidence).toBe("high");

    const cash = estimateCost({ components, coverage: { kind: "uninsured" } });
    expect(cash.patient?.typical).toBe(570); // 210 + 360
  });

  it("swaps in a new file version without leaving old partitions behind", async () => {
    await ingestLocalFile(ctx, await target(), [fixture("v3-wide.csv")]);
    const parts = await partitions();
    expect(parts).toHaveLength(3);
    expect(parts.every((p) => p.includes(`_h${hospitalId}_f2_`))).toBe(true);
    const { rows } = await pool.query("SELECT status FROM mrf_files WHERE hospital_id = $1 ORDER BY id", [hospitalId]);
    expect(rows.map((r) => r.status)).toEqual(["superseded", "loaded"]);
  });

  it("loads a multi-part file as one version, and skips it when nothing changed", async () => {
    const parts = [fixture("v3-tall.csv"), fixture("v3-wide.csv")];
    const first = await ingestLocalFile(ctx, await target(), parts);
    expect(first.status).toBe("loaded");
    const { rows } = await pool.query<{ parts: unknown[]; status: string }>(
      "SELECT parts, status FROM mrf_files WHERE hospital_id = $1 ORDER BY id DESC LIMIT 1",
      [hospitalId],
    );
    expect(rows[0]).toMatchObject({ status: "loaded" });
    expect(rows[0]!.parts).toHaveLength(2);
    const { rows: items } = await pool.query("SELECT count(*)::int AS n FROM charge_items WHERE hospital_id = $1", [hospitalId]);
    // 8 items in the tall part + 4 in the wide part, minus 2 that are identical in both
    // (same codes, prices, setting) and merge into one item carrying both parts' rates.
    expect(items[0].n).toBe(10);

    const again = await ingestLocalFile(ctx, await target(), parts);
    expect(again).toEqual({ status: "unchanged", reason: "same content as the loaded file" });

    // Forcing a reload of the attached version must swap, not drop, the live partitions.
    const before = await partitions();
    const forced = await ingestLocalFile(ctx, await target(), parts, { force: true });
    expect(forced.status).toBe("loaded");
    const after = await partitions();
    expect(after).toHaveLength(3);
    expect(after.some((p) => before.includes(p))).toBe(false);
    const { rows: still } = await pool.query("SELECT count(*)::int AS n FROM charge_items WHERE hospital_id = $1", [hospitalId]);
    expect(still[0].n).toBe(10);
  });

  it("removes a hospital and all of its data", async () => {
    await removeHospitalData(pool, hospitalId);
    expect(await partitions()).toEqual([]);
    const { rowCount } = await pool.query("SELECT 1 FROM price_summary WHERE hospital_id = $1", [hospitalId]);
    expect(rowCount).toBe(0);
  });
});
