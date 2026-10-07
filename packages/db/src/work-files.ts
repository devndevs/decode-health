/**
 * The contract between the parser (packages/ingest) and the bulk loader (load.ts).
 *
 * The parser turns one hospital file into three flat CSVs plus two small JSON
 * files in a work directory, with no database access. The loader COPYs them
 * into Postgres. Keeping the two steps apart means a file can be parsed and
 * inspected offline (`pnpm ingest validate <file>`), and a load can be retried
 * without re-parsing.
 *
 * Every record is exactly one line: the writer strips newlines from text, which
 * lets the loader rewrite rates.csv line-by-line while streaming.
 */

export const WORK_FILES = {
  items: {
    file: "items.csv",
    columns: [
      "item_id",
      "description",
      "setting",
      "billing_class",
      "modifiers",
      "drug_unit",
      "drug_unit_type",
      "gross",
      "discounted_cash",
      "min_negotiated",
      "max_negotiated",
      "notes",
    ],
  },
  codes: {
    file: "codes.csv",
    columns: ["item_id", "code_type", "code"],
  },
  /** First column is the *local* payer-plan id from payer_plans.csv; the loader swaps in the global id. */
  rates: {
    file: "rates.csv",
    columns: [
      "payer_plan_id",
      "item_id",
      "negotiated_dollar",
      "negotiated_percentage",
      "negotiated_algorithm",
      "median_allowed",
      "p10_allowed",
      "p90_allowed",
      "allowed_count",
      "estimated_amount",
      "methodology",
      "effective_amount",
      "effective_basis",
      "notes",
    ],
  },
} as const;

/** JSON array of [localId, payerName, planName]. Small (hundreds of entries), so not CSV. */
export const PAYER_PLANS_FILE = "payer_plans.json";
export type PayerPlanEntry = [localId: number, payerName: string, planName: string];

export const META_FILE = "meta.json";

export interface ParseStats {
  rowsRead: number;
  items: number;
  codes: number;
  rates: number;
  payerPlans: number;
  unknownCodeTypes: Record<string, number>;
  itemsWithoutCodes: number;
  ratesWithoutAmount: number;
  warnings: string[];
}

export interface FileMeta {
  format: "csv_tall" | "csv_wide" | "json";
  templateVersion: string | null;
  hospitalName: string | null;
  lastUpdatedOn: string | null;
  locationNames: string[];
  addresses: string[];
  licenseNumber: string | null;
  licenseState: string | null;
  type2Npis: string[];
  attesterName: string | null;
  attestation: boolean | null;
  financialAidPolicy: string | null;
}

export interface WorkDirManifest {
  meta: FileMeta;
  stats: ParseStats;
  parsedAt: string;
}
