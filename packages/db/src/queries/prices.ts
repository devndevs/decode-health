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

const SETTING_SCORE: Record<string, number> = { both: 1, unknown: 0 };
const CLASS_SCORE: Record<string, number> = { both: 1, unknown: 0 };

function specificity(row: SummaryRow, setting: string, billingClass: ComponentSpec["billingClass"]): number {
  const s = row.setting === setting ? 2 : (SETTING_SCORE[row.setting] ?? -1);
  const b = billingClass === "any" ? 0 : row.billing_class === billingClass ? 2 : (CLASS_SCORE[row.billing_class] ?? -1);
  return s * 10 + b;
}

/** Pick the single most specific summary row; ties go to the row backed by more rates. */
function best(rows: SummaryRow[], setting: string, billingClass: ComponentSpec["billingClass"]): AmountStats | null {
  let pick: SummaryRow | null = null;
  let pickScore = -Infinity;
  for (const r of rows) {
    const score = specificity(r, setting, billingClass);
    if (score < 0) continue;
    if (score > pickScore || (score === pickScore && pick && r.n > pick.n)) {
      pick = r;
      pickScore = score;
    }
  }
  return pick ? { n: pick.n, min: pick.min, p25: pick.p25, median: pick.median, p75: pick.p75, max: pick.max } : null;
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
