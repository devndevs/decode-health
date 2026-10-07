/**
 * Ballpark cost estimator.
 *
 * Two steps, kept separate so each is easy to test and explain to a user:
 *   1. Pick the best available price for each part of a service (the "price basis").
 *   2. Run that price through the person's benefits (deductible, coinsurance,
 *      copay, out-of-pocket max) to get what they would actually owe.
 *
 * Everything is a range, never a single number. Hospital files list many rates
 * for the same code, and the real bill depends on what actually happens at the
 * visit. We say so plainly instead of implying false precision.
 */
import { round2 } from "./charges";

export interface AmountStats {
  n: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
}

/** Everything we know about the price of one component (e.g. the facility fee) at one hospital. */
export interface ComponentPricing {
  key: string;
  label?: string;
  /** Rates for the person's payer AND product type (e.g. Aetna PPO). */
  plan: AmountStats | null;
  /** Rates for the person's payer, any product. */
  payer: AmountStats | null;
  /** Rates across every payer at this hospital. */
  allPayers: AmountStats | null;
  /** Discounted cash (self-pay) price. */
  cash: AmountStats | null;
  /** Chargemaster ("sticker") price. */
  gross: AmountStats | null;
}

export type BasisSource = "plan" | "payer" | "all_payers" | "cash" | "gross";
export type Confidence = "high" | "medium" | "low";

export interface Range {
  low: number;
  typical: number;
  high: number;
}

export interface PriceBasis extends Range {
  source: BasisSource;
  n: number;
  confidence: Confidence;
}

const ORDER: Record<"insured" | "uninsured", Array<[keyof ComponentPricing, BasisSource, Confidence]>> = {
  insured: [
    ["plan", "plan", "high"],
    ["payer", "payer", "medium"],
    ["allPayers", "all_payers", "low"],
    ["gross", "gross", "low"],
  ],
  uninsured: [
    ["cash", "cash", "high"],
    ["gross", "gross", "low"],
  ],
};

/** Interquartile range when we have enough rates to make it meaningful, otherwise min–max. */
export function statsToRange(s: AmountStats): Range {
  return s.n >= 4 ? { low: s.p25, typical: s.median, high: s.p75 } : { low: s.min, typical: s.median, high: s.max };
}

export function choosePriceBasis(c: ComponentPricing, coverage: "insured" | "uninsured"): PriceBasis | null {
  for (const [field, source, confidence] of ORDER[coverage]) {
    const stats = c[field] as AmountStats | null;
    if (stats && stats.n > 0) return { ...statsToRange(stats), source, n: stats.n, confidence };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Benefits
// ---------------------------------------------------------------------------

export interface BenefitInputs {
  /** How much of the deductible is left this year. 0 if met. */
  deductibleRemaining: number;
  /** False for services the plan covers before the deductible (common for copay office visits). */
  deductibleApplies: boolean;
  /** What you pay once the deductible is met (or if it doesn't apply). */
  afterDeductible: { type: "coinsurance"; percent: number } | { type: "copay"; amount: number };
  /** How much is left before the out-of-pocket maximum. null if unknown. */
  oopMaxRemaining: number | null;
}

export interface ShareBreakdown {
  allowed: number;
  deductible: number;
  costShare: number;
  patient: number;
  plan: number;
  cappedByOopMax: boolean;
}

export function patientShare(allowed: number, b: BenefitInputs): ShareBreakdown {
  const deductible = b.deductibleApplies ? Math.min(allowed, Math.max(0, b.deductibleRemaining)) : 0;
  const remainder = allowed - deductible;
  const costShare =
    b.afterDeductible.type === "coinsurance"
      ? (remainder * clamp(b.afterDeductible.percent, 0, 100)) / 100
      : Math.min(remainder, Math.max(0, b.afterDeductible.amount));

  let patient = deductible + costShare;
  let cappedByOopMax = false;
  if (b.oopMaxRemaining != null && patient > b.oopMaxRemaining) {
    patient = Math.max(0, b.oopMaxRemaining);
    cappedByOopMax = true;
  }
  return {
    allowed: round2(allowed),
    deductible: round2(deductible),
    costShare: round2(costShare),
    patient: round2(patient),
    plan: round2(allowed - patient),
    cappedByOopMax,
  };
}

// ---------------------------------------------------------------------------
// Estimate
// ---------------------------------------------------------------------------

export type Coverage = { kind: "insured"; benefits: BenefitInputs } | { kind: "uninsured" };

/** Machine-readable notes; the UI turns these into plain-language, translated explanations. */
export type EstimateNote =
  | "aca_preventive_no_cost"
  | "missing_components"
  | "using_payer_level_rates"
  | "using_all_payer_rates"
  | "using_gross_charges"
  | "capped_by_oop_max"
  | "self_pay_ask_for_discount"
  | "financial_assistance_may_apply"
  | "good_faith_estimate_right";

export interface EstimateResult {
  /** Total the hospital expects to be paid (you + your plan). */
  allowed: Range | null;
  /** What you would pay. */
  patient: Range | null;
  components: Array<{ key: string; label?: string; basis: PriceBasis | null }>;
  missing: string[];
  confidence: Confidence;
  notes: EstimateNote[];
}

const CONFIDENCE_RANK: Record<Confidence, number> = { high: 2, medium: 1, low: 0 };

export function estimateCost(input: {
  components: ComponentPricing[];
  coverage: Coverage;
  acaPreventive?: boolean;
}): EstimateResult {
  const kind = input.coverage.kind;
  const components = input.components.map((c) => ({ key: c.key, label: c.label, basis: choosePriceBasis(c, kind) }));
  const priced = components.filter((c): c is typeof c & { basis: PriceBasis } => c.basis != null);
  const missing = components.filter((c) => c.basis == null).map((c) => c.key);

  const notes = new Set<EstimateNote>();
  if (missing.length) notes.add("missing_components");

  if (!priced.length) {
    return { allowed: null, patient: null, components, missing, confidence: "low", notes: [...notes] };
  }

  const allowed: Range = {
    low: round2(sum(priced.map((c) => c.basis.low))),
    typical: round2(sum(priced.map((c) => c.basis.typical))),
    high: round2(sum(priced.map((c) => c.basis.high))),
  };

  for (const c of priced) {
    if (c.basis.source === "payer") notes.add("using_payer_level_rates");
    if (c.basis.source === "all_payers") notes.add("using_all_payer_rates");
    if (c.basis.source === "gross") notes.add("using_gross_charges");
  }

  let patient: Range;
  if (input.coverage.kind === "uninsured") {
    patient = allowed;
    if (notes.has("using_gross_charges")) notes.add("self_pay_ask_for_discount");
    notes.add("financial_assistance_may_apply");
    notes.add("good_faith_estimate_right");
  } else if (input.acaPreventive) {
    patient = { low: 0, typical: 0, high: 0 };
    notes.add("aca_preventive_no_cost");
  } else {
    const b = input.coverage.benefits;
    const lo = patientShare(allowed.low, b);
    const mid = patientShare(allowed.typical, b);
    const hi = patientShare(allowed.high, b);
    if (lo.cappedByOopMax || mid.cappedByOopMax || hi.cappedByOopMax) notes.add("capped_by_oop_max");
    patient = { low: lo.patient, typical: mid.patient, high: hi.patient };
  }

  let confidence = priced.reduce<Confidence>(
    (acc, c) => (CONFIDENCE_RANK[c.basis.confidence] < CONFIDENCE_RANK[acc] ? c.basis.confidence : acc),
    "high",
  );
  if (missing.length) confidence = "low";

  return { allowed, patient, components, missing, confidence, notes: [...notes] };
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
