/**
 * Streaming parser for CMS template CSVs, "tall" and "wide", v2.x and v3.x.
 *
 * Layout (both variants):
 *   row 1  general data element headers (hospital_name, last_updated_on, version, ...)
 *   row 2  their values
 *   row 3  column headers for the charge data
 *   row 4+ one row per item (wide) or per item × payer/plan (tall)
 *
 * Tall: payer_name / plan_name columns, one rate per row.
 * Wide: payer and plan are embedded in the column header, e.g.
 *   standard_charge|Aetna|PPO|negotiated_dollar, median_amount|Aetna|PPO
 * so each row carries every payer's rate for that item.
 */
import type { Readable } from "node:stream";
import { parse } from "csv-parse";
import {
  canonicalizeCode,
  cleanText,
  normalizeBillingClass,
  normalizeMethodology,
  normalizeSetting,
  parseAmount,
  parsePercentage,
  splitModifiers,
  type CanonicalCode,
  type NormalizedItem,
  type NormalizedRate,
} from "@decode-health/core";
import { emptyMeta, MAX_WARNINGS, normalizeDate, parseBool, splitPipes, type ParseResult, type ParsedRecord } from "./types";

/** Lowercase, trim, and drop spaces around pipes — CMS says header case and spacing don't matter. */
function key(h: string): string {
  return h
    .split("|")
    .map((p) => p.trim().toLowerCase())
    .join("|");
}

// ---------------------------------------------------------------------------
// Rows 1–2: general data elements
// ---------------------------------------------------------------------------

function readMeta(headers: string[], values: string[], format: "csv_tall" | "csv_wide") {
  const meta = emptyMeta(format);
  headers.forEach((raw, i) => {
    const k = key(raw);
    const v = values[i] ?? "";
    if (k === "hospital_name") meta.hospitalName = cleanText(v);
    else if (k === "last_updated_on") meta.lastUpdatedOn = normalizeDate(v);
    else if (k === "version") meta.templateVersion = cleanText(v);
    else if (k === "location_name" || k === "hospital_location") meta.locationNames = splitPipes(v);
    else if (k === "hospital_address") meta.addresses = splitPipes(v);
    else if (k.startsWith("license_number")) {
      meta.licenseNumber = cleanText(v);
      meta.licenseState = raw.split("|")[1]?.trim().toUpperCase() || null;
    } else if (k === "type_2_npi") meta.type2Npis = splitPipes(v);
    else if (k === "attester_name") meta.attesterName = cleanText(v);
    else if (k === "financial_aid_policy") meta.financialAidPolicy = cleanText(v);
    else if (k.startsWith("to the best of its knowledge")) meta.attestation = parseBool(v);
  });
  return meta;
}

// ---------------------------------------------------------------------------
// Row 3: column map
// ---------------------------------------------------------------------------

type ItemField =
  | "description"
  | "setting"
  | "billing_class"
  | "modifiers"
  | "drug_unit"
  | "drug_type"
  | "gross"
  | "cash"
  | "min"
  | "max"
  | "notes";

type RateField =
  | "payer_name"
  | "plan_name"
  | "dollar"
  | "percentage"
  | "algorithm"
  | "methodology"
  | "median"
  | "p10"
  | "p90"
  | "count"
  | "estimated"
  | "notes";

const ITEM_COLUMNS: Record<string, ItemField> = {
  description: "description",
  setting: "setting",
  billing_class: "billing_class",
  modifiers: "modifiers",
  drug_unit_of_measurement: "drug_unit",
  drug_type_of_measurement: "drug_type",
  "standard_charge|gross": "gross",
  "standard_charge|discounted_cash": "cash",
  "standard_charge|min": "min",
  "standard_charge|max": "max",
  additional_generic_notes: "notes",
};

const TALL_RATE_COLUMNS: Record<string, RateField> = {
  payer_name: "payer_name",
  plan_name: "plan_name",
  "standard_charge|negotiated_dollar": "dollar",
  "standard_charge|negotiated_percentage": "percentage",
  "standard_charge|negotiated_algorithm": "algorithm",
  "standard_charge|methodology": "methodology",
  median_amount: "median",
  "10th_percentile": "p10",
  "90th_percentile": "p90",
  count: "count",
  estimated_amount: "estimated",
};

/** Wide headers: <prefix>|payer|plan[|suffix] */
const WIDE_STANDARD_CHARGE_SUFFIX: Record<string, RateField> = {
  negotiated_dollar: "dollar",
  negotiated_percentage: "percentage",
  negotiated_algorithm: "algorithm",
  methodology: "methodology",
};
const WIDE_PREFIX: Record<string, RateField> = {
  median_amount: "median",
  "10th_percentile": "p10",
  "90th_percentile": "p90",
  count: "count",
  estimated_amount: "estimated",
  additional_payer_notes: "notes",
};

interface ColumnMap {
  layout: "tall" | "wide";
  item: Array<[number, ItemField]>;
  codes: Map<number, { code?: number; type?: number }>;
  tallRate: Array<[number, RateField]>;
  wideGroups: Array<{ payerName: string; planName: string; fields: Array<[number, RateField]> }>;
  unknown: string[];
}

function buildColumnMap(headers: string[]): ColumnMap {
  const map: ColumnMap = { layout: "tall", item: [], codes: new Map(), tallRate: [], wideGroups: [], unknown: [] };
  const groups = new Map<string, ColumnMap["wideGroups"][number]>();
  const group = (payerName: string, planName: string) => {
    const k = `${payerName}\u0000${planName}`;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { payerName, planName, fields: [] }));
    return g;
  };

  headers.forEach((raw, i) => {
    const k = key(raw);
    const parts = raw.split("|").map((p) => p.trim());
    const p0 = parts[0]?.toLowerCase() ?? "";

    const itemField = ITEM_COLUMNS[k];
    if (itemField) return void map.item.push([i, itemField]);

    const tallField = TALL_RATE_COLUMNS[k];
    if (tallField) return void map.tallRate.push([i, tallField]);

    const code = /^code\|(\d+)(\|type)?$/.exec(k);
    if (code) {
      const n = Number(code[1]);
      const entry = map.codes.get(n) ?? {};
      if (code[2]) entry.type = i;
      else entry.code = i;
      map.codes.set(n, entry);
      return;
    }

    if (p0 === "standard_charge" && parts.length === 4) {
      const f = WIDE_STANDARD_CHARGE_SUFFIX[parts[3]!.toLowerCase()];
      if (f) return void group(parts[1]!, parts[2]!).fields.push([i, f]);
    }
    if (parts.length === 3 && WIDE_PREFIX[p0]) {
      return void group(parts[1]!, parts[2]!).fields.push([i, WIDE_PREFIX[p0]!]);
    }
    if (k) map.unknown.push(raw);
  });

  map.wideGroups = [...groups.values()];
  map.layout = map.wideGroups.length > 0 && !map.tallRate.some(([, f]) => f === "payer_name") ? "wide" : "tall";
  if (!map.item.some(([, f]) => f === "description")) {
    throw new Error('Row 3 has no "description" column — this does not look like a CMS template CSV (v2.0+).');
  }
  return map;
}

// ---------------------------------------------------------------------------
// Rows 4+
// ---------------------------------------------------------------------------

function readItem(row: string[], cm: ColumnMap, unknownTypes: Map<string, number>): NormalizedItem {
  const f: Partial<Record<ItemField, string>> = {};
  for (const [i, field] of cm.item) f[field] = row[i];

  const codes: CanonicalCode[] = [];
  const seen = new Set<string>();
  for (const { code, type } of cm.codes.values()) {
    if (code == null) continue;
    const c = canonicalizeCode(type != null ? row[type] : null, row[code]);
    if (!c) continue;
    if (!c.knownType) unknownTypes.set(c.type, (unknownTypes.get(c.type) ?? 0) + 1);
    const k = `${c.type}:${c.code}`;
    if (!seen.has(k)) {
      seen.add(k);
      codes.push(c);
    }
  }

  return {
    description: cleanText(f.description) ?? "",
    codes,
    setting: normalizeSetting(f.setting),
    billingClass: normalizeBillingClass(f.billing_class),
    modifiers: splitModifiers(f.modifiers),
    drugUnit: parseAmount(f.drug_unit),
    drugUnitType: cleanText(f.drug_type)?.toUpperCase() ?? null,
    gross: parseAmount(f.gross),
    discountedCash: parseAmount(f.cash),
    minNegotiated: parseAmount(f.min),
    maxNegotiated: parseAmount(f.max),
    notes: cleanText(f.notes),
  };
}

function toRate(payerName: string, planName: string, f: Partial<Record<RateField, string>>): NormalizedRate | null {
  const rate: NormalizedRate = {
    payerName,
    planName,
    negotiatedDollar: parseAmount(f.dollar),
    negotiatedPercentage: parsePercentage(f.percentage),
    negotiatedAlgorithm: cleanText(f.algorithm),
    medianAllowed: parseAmount(f.median),
    p10Allowed: parseAmount(f.p10),
    p90Allowed: parseAmount(f.p90),
    allowedCount: cleanText(f.count),
    estimatedAmount: parseAmount(f.estimated),
    methodology: normalizeMethodology(f.methodology),
    notes: cleanText(f.notes),
  };
  const hasPrice =
    rate.negotiatedDollar != null ||
    rate.negotiatedPercentage != null ||
    rate.negotiatedAlgorithm != null ||
    rate.medianAllowed != null ||
    rate.estimatedAmount != null;
  return hasPrice ? rate : null;
}

function readRates(row: string[], cm: ColumnMap, item: NormalizedItem): NormalizedRate[] {
  if (cm.layout === "tall") {
    const f: Partial<Record<RateField, string>> = {};
    for (const [i, field] of cm.tallRate) f[field] = row[i];
    const payer = cleanText(f.payer_name);
    if (!payer) return [];
    // Tall files have no payer-notes column, so CMS has hospitals put payer-specific
    // notes in the generic notes. On payer rows, move them to the rate; otherwise
    // the same item would look different on every payer row and never dedupe.
    const rate = toRate(payer, cleanText(f.plan_name) ?? "", { ...f, notes: item.notes ?? undefined });
    item.notes = null;
    return rate ? [rate] : [];
  }
  const out: NormalizedRate[] = [];
  for (const g of cm.wideGroups) {
    const f: Partial<Record<RateField, string>> = {};
    for (const [i, field] of g.fields) f[field] = row[i];
    const rate = toRate(g.payerName, g.planName, f);
    if (rate) out.push(rate);
  }
  return out;
}

export interface CsvParseOptions {
  /** Hard cap on a single CSV record, to survive files with an unbalanced quote. */
  maxRecordBytes?: number;
}

export async function parseCsv(input: Readable, opts: CsvParseOptions = {}): Promise<ParseResult> {
  const parser = input.pipe(
    parse({
      bom: true,
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: true,
      max_record_size: opts.maxRecordBytes ?? 8 * 1024 * 1024,
    }),
  );
  const it = parser[Symbol.asyncIterator]() as AsyncIterator<string[]>;
  const next = async (what: string) => {
    const r = await it.next();
    if (r.done) throw new Error(`CSV ended before ${what}`);
    return r.value;
  };

  const metaHeaders = await next("row 1 (general data element headers)");
  const metaValues = await next("row 2 (general data element values)");
  const columnHeaders = await next("row 3 (column headers)");
  const cm = buildColumnMap(columnHeaders);
  const meta = readMeta(metaHeaders, metaValues, cm.layout === "wide" ? "csv_wide" : "csv_tall");

  const warnings: string[] = [];
  if (cm.unknown.length) warnings.push(`Ignored ${cm.unknown.length} unrecognized column(s): ${cm.unknown.slice(0, 5).join(", ")}`);
  if (!meta.templateVersion) warnings.push("No template version in row 2");
  const unknownTypes = new Map<string, number>();

  async function* records(): AsyncGenerator<ParsedRecord> {
    try {
      for (let r = await it.next(); !r.done; r = await it.next()) {
        const row = r.value;
        const item = readItem(row, cm, unknownTypes);
        if (!item.description && !item.codes.length) continue;
        yield { item, rates: readRates(row, cm, item) };
      }
    } finally {
      for (const [t, n] of unknownTypes) {
        if (warnings.length < MAX_WARNINGS) warnings.push(`Unknown code type "${t}" on ${n} row(s)`);
      }
      parser.destroy();
    }
  }

  return { meta, records: records(), warnings };
}
