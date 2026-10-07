/**
 * The normalized shape every hospital file is converted into, regardless of
 * whether it arrived as CSV "tall", CSV "wide", or JSON, or which CMS template
 * version (v2.x, v3.x) it used.
 */
import type { CanonicalCode } from "./codes";

export type Setting = "inpatient" | "outpatient" | "both";
export type BillingClass = "professional" | "facility" | "both";
export type Methodology = "case rate" | "fee schedule" | "percent of total billed charges" | "per diem" | "other";

/** One chargeable item or service at one hospital (a "standard charge" row, minus payer detail). */
export interface NormalizedItem {
  description: string;
  codes: CanonicalCode[];
  setting: Setting | null;
  billingClass: BillingClass | null;
  modifiers: string[];
  drugUnit: number | null;
  drugUnitType: string | null;
  gross: number | null;
  discountedCash: number | null;
  minNegotiated: number | null;
  maxNegotiated: number | null;
  notes: string | null;
}

/** A payer/plan-specific price for a NormalizedItem. */
export interface NormalizedRate {
  payerName: string;
  planName: string;
  negotiatedDollar: number | null;
  negotiatedPercentage: number | null;
  negotiatedAlgorithm: string | null;
  /** v3.0+: allowed amounts from historical remittances (EDI 835). */
  medianAllowed: number | null;
  p10Allowed: number | null;
  p90Allowed: number | null;
  /** v3.0+: "0", "1 through 10", or a whole number. Kept as text per the spec. */
  allowedCount: string | null;
  /** v2.x only: replaced by the allowed-amount fields in v3.0. */
  estimatedAmount: number | null;
  methodology: Methodology | null;
  notes: string | null;
}

export type EffectiveBasis = "negotiated_dollar" | "median_allowed" | "estimated_amount" | "percent_of_gross";

export interface EffectiveAmount {
  amount: number;
  basis: EffectiveBasis;
}

/**
 * A negotiated rate below this share of the item's own list price is treated as
 * a data error, not a price. Real example: UC San Diego lists a $0.67 "fee
 * schedule rate" for a hospital delivery whose list price is $26,000. Raw values
 * are still stored; they just don't feed comparisons or estimates.
 */
export const MIN_SHARE_OF_GROSS = 0.01;

/**
 * Collapse the many ways a hospital can express a price into one dollar figure
 * we can compare, plus a record of how we got it. Order is most to least direct.
 *
 * Per-diem rates are a price per day, so they can't be compared with whole-stay
 * prices without knowing the length of stay; only their historical allowed
 * amounts (which are per claim) are used.
 */
export function effectiveAmount(rate: NormalizedRate, item: Pick<NormalizedItem, "gross">): EffectiveAmount | null {
  const candidate = ((): EffectiveAmount | null => {
    if (rate.methodology === "per diem") {
      return rate.medianAllowed != null ? { amount: rate.medianAllowed, basis: "median_allowed" } : null;
    }
    if (rate.negotiatedDollar != null) return { amount: rate.negotiatedDollar, basis: "negotiated_dollar" };
    if (rate.medianAllowed != null) return { amount: rate.medianAllowed, basis: "median_allowed" };
    if (rate.estimatedAmount != null) return { amount: rate.estimatedAmount, basis: "estimated_amount" };
    if (rate.negotiatedPercentage != null && item.gross != null && rate.methodology === "percent of total billed charges") {
      return { amount: round2((item.gross * rate.negotiatedPercentage) / 100), basis: "percent_of_gross" };
    }
    return null;
  })();
  if (candidate && item.gross != null && candidate.amount < item.gross * MIN_SHARE_OF_GROSS) return null;
  return candidate;
}

// ---------------------------------------------------------------------------
// Lenient field parsers. Hospital files violate the spec constantly ("$1,234.00",
// "N/A", "0"), so these accept what they can and return null for the rest.
// ---------------------------------------------------------------------------

const NULLISH = new Set(["", "n/a", "na", "null", "none", "-", "--", "not applicable"]);

export function cleanText(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  return NULLISH.has(s.toLowerCase()) ? null : s;
}

/**
 * Some hospitals write all nines (999999999, 9999999.99, ...) to mean "insufficient
 * data" — UC San Diego's file says so in its notes. Match the pattern exactly rather
 * than using a dollar cutoff: gene therapies legitimately carry multi-million charges.
 */
export function isSentinelAmount(n: number): boolean {
  return /^9{7,}(\.(9+|0+))?$/.test(String(n));
}

/** Parse a positive dollar amount. Zero, negatives, and "insufficient data" sentinels are treated as missing. */
export function parseAmount(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : Number(cleanText(raw)?.replace(/[$,\s]/g, "") ?? NaN);
  return Number.isFinite(n) && n > 0 && !isSentinelAmount(n) ? n : null;
}

/** Parse a percentage. Accepts "85", "85%", "85.5". */
export function parsePercentage(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? raw : null;
  const s = cleanText(raw);
  if (s == null) return null;
  const n = Number(s.replace(/[%\s,]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function normalizeSetting(raw: unknown): Setting | null {
  const s = cleanText(raw)?.toLowerCase();
  if (s === "inpatient" || s === "outpatient" || s === "both") return s;
  if (s === "ip") return "inpatient";
  if (s === "op") return "outpatient";
  return null;
}

export function normalizeBillingClass(raw: unknown): BillingClass | null {
  const s = cleanText(raw)?.toLowerCase();
  if (s === "professional" || s === "facility" || s === "both") return s;
  if (s === "pro") return "professional";
  return null;
}

export function normalizeMethodology(raw: unknown): Methodology | null {
  const s = cleanText(raw)?.toLowerCase().replace(/\s+/g, " ");
  switch (s) {
    case "case rate":
    case "fee schedule":
    case "percent of total billed charges":
    case "per diem":
    case "other":
      return s;
    case "percent of billed charges":
    case "percentage of billed charges":
    case "percent of charges":
      return "percent of total billed charges";
    default:
      return s ? "other" : null;
  }
}

export function splitModifiers(raw: unknown): string[] {
  const s = cleanText(raw);
  if (!s) return [];
  return s
    .split(/[|,;\s]+/)
    .map((m) => m.trim().toUpperCase())
    .filter(Boolean);
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
