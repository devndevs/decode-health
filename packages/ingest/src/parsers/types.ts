import type { NormalizedItem, NormalizedRate } from "@decode-health/core";
import type { FileMeta } from "@decode-health/db";

/** One item/service with the payer-specific rates that came with it. */
export interface ParsedRecord {
  item: NormalizedItem;
  rates: NormalizedRate[];
}

/**
 * A parser streams records and fills in `meta` as it goes. For CSV, meta is
 * complete after the first two rows; for JSON, top-level fields may appear
 * after the big array, so only read `meta` once iteration has finished.
 */
export interface ParseResult {
  meta: FileMeta;
  records: AsyncGenerator<ParsedRecord>;
  /** Non-fatal problems noticed while parsing (capped). */
  warnings: string[];
}

export function emptyMeta(format: FileMeta["format"]): FileMeta {
  return {
    format,
    templateVersion: null,
    hospitalName: null,
    lastUpdatedOn: null,
    locationNames: [],
    addresses: [],
    licenseNumber: null,
    licenseState: null,
    type2Npis: [],
    attesterName: null,
    attestation: null,
    financialAidPolicy: null,
  };
}

/** Accepts YYYY-MM-DD, M/D/YYYY, MM/DD/YYYY (all permitted by CMS). Returns ISO date or null. */
export function normalizeDate(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  return null;
}

export function splitPipes(raw: unknown): string[] {
  return String(raw ?? "")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseBool(raw: unknown): boolean | null {
  if (typeof raw === "boolean") return raw;
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "true" || s === "yes" || s === "y") return true;
  if (s === "false" || s === "no" || s === "n") return false;
  return null;
}

export const MAX_WARNINGS = 50;
