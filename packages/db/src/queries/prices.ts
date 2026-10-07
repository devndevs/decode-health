/**
 * Price lookups that feed the estimator in @decode-health/core.
 *
 * Reads only price_summary (small, pre-aggregated), never the raw partitions,
 * so pages stay fast as coverage grows from one hospital to the whole state.
 */
import type { AmountStats, ComponentPricing, ProductType } from "@decode-health/core";
import type { Pool } from "../client";

export interface ComponentSpec {
  codeType: string;
  code: string;
  billingClass: "professional" | "facility" | "any";
  label?: string;
}

interface SummaryRow extends AmountStats {
  hospital_id: number;
  code_type: string;
  code: string;
  setting: string;
  billing_class: string;
  scope: "cash" | "gross" | "all_payers" | "payer" | "payer_product";
  payer_id: number;
  product_type: string;
}

/**
 * How well a summary row fits what we're pricing. "both" fits as well as an
 * exact match (it explicitly covers it); "unknown" (hospital didn't say) fits less.
 */
function specificity(row: SummaryRow, setting: string, billingClass: ComponentSpec["billingClass"]): number {
  const s = row.setting === setting || row.setting === "both" ? 2 : row.setting === "unknown" ? 1 : -1;
  const b =
    billingClass === "any" || row.billing_class === billingClass || row.billing_class === "both"
      ? 2
      : row.billing_class === "unknown"
        ? 1
        : -1;
  return s < 0 || b < 0 ? -1 : s * 10 + b;
}

/**
 * Combine stats from several rows into one honest range. Hospitals sometimes list
 * the same code more than once at very different prices (UC San Diego has two
 * blood-draw items: $16.50 and $493 cash); rather than silently picking one, the
 * range spans both. Quartiles are bounded (min of p25s, max of p75s) and the
 * median is n-weighted — an approximation, since the raw rates aren't re-read.
 */
export function mergeStats(rows: AmountStats[]): AmountStats | null {
  if (!rows.length) return null;
  if (rows.length === 1) {
    const { n, min, p25, median, p75, max } = rows[0]!;
    return { n, min, p25, median, p75, max };
  }
  const n = rows.reduce((a, r) => a + r.n, 0);
  return {
    n,
    min: Math.min(...rows.map((r) => r.min)),
    p25: Math.min(...rows.map((r) => r.p25)),
    median: Math.round((rows.reduce((a, r) => a + r.median * r.n, 0) / n) * 100) / 100,
    p75: Math.max(...rows.map((r) => r.p75)),
    max: Math.max(...rows.map((r) => r.max)),
  };
}

/** Merge all rows tied for the best fit. */
function best(rows: SummaryRow[], setting: string, billingClass: ComponentSpec["billingClass"]): AmountStats | null {
  let top = -1;
  let picked: SummaryRow[] = [];
  for (const r of rows) {
    const score = specificity(r, setting, billingClass);
    if (score < 0 || score < top) continue;
    if (score > top) {
      top = score;
      picked = [];
    }
    picked.push(r);
  }
  return mergeStats(picked);
}

export async function componentPricing(
  pool: Pool,
  opts: {
    hospitalIds: number[];
    components: ComponentSpec[];
    setting: "inpatient" | "outpatient";
    payerSlug?: string | null;
    productType?: ProductType | null;
  },
): Promise<Map<number, ComponentPricing[]>> {
  const { rows } = await pool.query<SummaryRow>(
    `SELECT s.hospital_id, s.code_type, s.code, s.setting, s.billing_class, s.scope, s.payer_id, s.product_type,
            s.n, s.min, s.p25, s.median, s.p75, s.max
     FROM price_summary s
     WHERE s.hospital_id = ANY($1::int[])
       AND (s.code_type, s.code) IN (SELECT * FROM unnest($2::text[], $3::text[]))
       AND s.setting IN ($4, 'both', 'unknown')
       AND (s.scope IN ('cash', 'gross', 'all_payers')
            OR s.payer_id = (SELECT id FROM payers WHERE slug = $5))`,
    [
      opts.hospitalIds,
      opts.components.map((c) => c.codeType),
      opts.components.map((c) => c.code),
      opts.setting,
      opts.payerSlug ?? null,
    ],
  );

  const out = new Map<number, ComponentPricing[]>();
  for (const hospitalId of opts.hospitalIds) {
    out.set(
      hospitalId,
      opts.components.map((comp) => {
        const mine = rows.filter((r) => r.hospital_id === hospitalId && r.code_type === comp.codeType && r.code === comp.code);
        const scope = (s: SummaryRow["scope"]) => mine.filter((r) => r.scope === s);
        const productRows = scope("payer_product");
        const plan =
          (opts.productType && best(productRows.filter((r) => r.product_type === opts.productType), opts.setting, comp.billingClass)) ||
          best(productRows.filter((r) => r.product_type === "all"), opts.setting, comp.billingClass);
        return {
          key: `${comp.codeType}:${comp.code}`,
          label: comp.label,
          plan: plan ?? null,
          payer: best(scope("payer"), opts.setting, comp.billingClass),
          allPayers: best(scope("all_payers"), opts.setting, comp.billingClass),
          cash: best(scope("cash"), opts.setting, comp.billingClass),
          gross: best(scope("gross"), opts.setting, comp.billingClass),
        };
      }),
    );
  }
  return out;
}
