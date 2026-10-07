/** Bookkeeping for mrf_files: one row per distinct version of a hospital's price file. */
import { createHash } from "node:crypto";
import type { Pool } from "./client";
import type { WorkDirManifest } from "./work-files";

/** One part of a (possibly multi-part) hospital file version. */
export interface MrfPart {
  url: string;
  storageKey: string;
  sha256: string;
  sizeBytes: number;
  etag: string | null;
  lastModified: string | null;
}

export interface MrfFileRow {
  id: number;
  hospital_id: number;
  source_url: string;
  storage_key: string;
  sha256: string;
  size_bytes: number;
  parts: MrfPart[];
  etag: string | null;
  last_modified: string | null;
  status: "fetched" | "parsed" | "loaded" | "superseded" | "failed";
  fetched_at: Date;
}

export interface HospitalIngestTarget {
  id: number;
  slug: string;
  name: string;
  region_path: string;
  cms_hpt_txt_url: string | null;
  location_name_match: string[];
  mrf_urls_pinned: string[];
  mrf_urls_discovered: string[];
  current_mrf_file_id: number | null;
}

/** Hospitals to ingest: one by slug, or everything inside a region (by slug, including sub-regions). */
export async function ingestTargets(pool: Pool, sel: { hospital?: string; region?: string }): Promise<HospitalIngestTarget[]> {
  const { rows } = await pool.query<HospitalIngestTarget>(
    `SELECT h.id, h.slug, h.name, r.path AS region_path, h.cms_hpt_txt_url, h.location_name_match,
            h.mrf_urls_pinned, h.mrf_urls_discovered, h.current_mrf_file_id
     FROM hospitals h
     JOIN regions r ON r.id = h.region_id
     WHERE ($1::text IS NULL OR h.slug = $1)
       AND ($2::text IS NULL OR r.path = (SELECT path FROM regions WHERE slug = $2)
            OR r.path LIKE (SELECT path FROM regions WHERE slug = $2) || '/%')
     ORDER BY h.slug`,
    [sel.hospital ?? null, sel.region ?? null],
  );
  return rows;
}

export async function setDiscoveredUrls(pool: Pool, hospitalId: number, mrfUrls: string[], sourcePageUrl: string | null) {
  await pool.query(
    `UPDATE hospitals SET mrf_urls_discovered = $2, source_page_url = COALESCE($3, source_page_url),
       discovered_at = now(), updated_at = now() WHERE id = $1`,
    [hospitalId, mrfUrls, sourcePageUrl],
  );
}

export async function latestMrfFile(pool: Pool, hospitalId: number): Promise<MrfFileRow | null> {
  const { rows } = await pool.query<MrfFileRow>(
    "SELECT * FROM mrf_files WHERE hospital_id = $1 ORDER BY fetched_at DESC, id DESC LIMIT 1",
    [hospitalId],
  );
  return rows[0] ?? null;
}

/** Identity of a multi-part version: hash of the ordered part hashes (a single part keeps its own hash). */
export function versionHash(parts: Array<Pick<MrfPart, "sha256">>): string {
  if (parts.length === 1) return parts[0]!.sha256;
  return createHash("sha256").update(parts.map((p) => p.sha256).join("\n")).digest("hex");
}

/** Record a downloaded file version. Same bytes as a version we already have → returns the existing row. */
export async function recordMrfFile(
  pool: Pool,
  f: { hospitalId: number; parts: MrfPart[] },
): Promise<{ row: MrfFileRow; isNew: boolean }> {
  if (!f.parts.length) throw new Error("recordMrfFile needs at least one part");
  const first = f.parts[0]!;
  const sha256 = versionHash(f.parts);
  const inserted = await pool.query<MrfFileRow>(
    `INSERT INTO mrf_files (hospital_id, source_url, storage_key, sha256, size_bytes, parts, etag, last_modified)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (hospital_id, sha256) DO NOTHING
     RETURNING *`,
    [
      f.hospitalId,
      first.url,
      first.storageKey,
      sha256,
      f.parts.reduce((n, p) => n + p.sizeBytes, 0),
      JSON.stringify(f.parts),
      first.etag,
      first.lastModified,
    ],
  );
  if (inserted.rows[0]) return { row: inserted.rows[0], isNew: true };
  const { rows } = await pool.query<MrfFileRow>("SELECT * FROM mrf_files WHERE hospital_id = $1 AND sha256 = $2", [
    f.hospitalId,
    sha256,
  ]);
  return { row: rows[0]!, isNew: false };
}

export async function markParsed(pool: Pool, id: number, m: WorkDirManifest) {
  await pool.query(
    `UPDATE mrf_files SET status = CASE WHEN status = 'loaded' THEN status ELSE 'parsed' END,
       format = $2, template_version = $3, last_updated_on = $4::date, hospital_name_in_file = $5,
       location_names = $6, attester_name = $7, stats = $8, parsed_at = now(), error = NULL
     WHERE id = $1`,
    [
      id,
      m.meta.format,
      m.meta.templateVersion,
      m.meta.lastUpdatedOn,
      m.meta.hospitalName,
      m.meta.locationNames,
      m.meta.attesterName,
      JSON.stringify(m.stats),
    ],
  );
}

export async function markFailed(pool: Pool, id: number, error: string) {
  await pool.query("UPDATE mrf_files SET status = 'failed', error = $2 WHERE id = $1", [id, error.slice(0, 4000)]);
}

export async function unmatchedPayerPlans(pool: Pool, limit = 50) {
  const { rows } = await pool.query<{ payer_name: string; plan_name: string; product_type: string; rates: number }>(
    `SELECT pp.payer_name, pp.plan_name, pp.product_type, count(r.*)::int AS rates
     FROM raw_payer_plans pp
     LEFT JOIN charge_rates r ON r.payer_plan_id = pp.id
     WHERE pp.payer_id IS NULL
     GROUP BY pp.id
     ORDER BY rates DESC, pp.payer_name
     LIMIT $1`,
    [limit],
  );
  return rows;
}
