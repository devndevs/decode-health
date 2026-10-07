/**
 * Streaming parser for CMS template JSON files (v2.x and v3.x).
 *
 * These files are a single top-level object whose `standard_charge_information`
 * array can be many gigabytes. We tokenize the stream and assemble one array
 * element at a time, so memory stays flat. Every other top-level key is small
 * metadata and is assembled whole.
 */
import type { Readable } from "node:stream";
import { parser } from "stream-json";
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
  type NormalizedRate,
} from "@decode-health/core";
import { emptyMeta, MAX_WARNINGS, normalizeDate, parseBool, type ParseResult, type ParsedRecord } from "./types";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Token = { name: string; value?: unknown };

/** Guards against pathological nesting in untrusted input. Real MRFs are ~6 levels deep. */
const MAX_DEPTH = 32;

/** Builds one JSON value from a token sequence. `done` flips when the value is complete. */
class ValueAssembler {
  private stack: Array<Json[] | { [k: string]: Json }> = [];
  private key: string | null = null;
  current: Json = null;
  done = false;

  consume(t: Token) {
    switch (t.name) {
      case "startObject":
        return this.open({});
      case "startArray":
        return this.open([]);
      case "endObject":
      case "endArray":
        return this.close();
      case "keyValue":
        this.key = t.value as string;
        return;
      case "stringValue":
        return this.value(t.value as string);
      case "numberValue":
        return this.value(Number(t.value));
      case "nullValue":
        return this.value(null);
      case "trueValue":
        return this.value(true);
      case "falseValue":
        return this.value(false);
    }
  }

  private open(container: Json[] | { [k: string]: Json }) {
    if (this.stack.length >= MAX_DEPTH) throw new Error(`JSON nested deeper than ${MAX_DEPTH} levels`);
    this.attach(container);
    this.stack.push(container);
  }

  private close() {
    this.stack.pop();
    if (!this.stack.length) this.done = true;
  }

  private value(v: Json) {
    this.attach(v);
    if (!this.stack.length) this.done = true;
  }

  private attach(v: Json) {
    const top = this.stack[this.stack.length - 1];
    if (!top) this.current = v;
    else if (Array.isArray(top)) top.push(v);
    else top[this.key ?? ""] = v;
  }
}

const asObj = (v: Json | undefined): Record<string, Json> =>
  v && typeof v === "object" && !Array.isArray(v) ? v : {};
const asArr = (v: Json | undefined): Json[] => (Array.isArray(v) ? v : []);
const asStrings = (v: Json | undefined): string[] =>
  (Array.isArray(v) ? v : v == null ? [] : [v]).map((x) => cleanText(x)).filter((x): x is string => !!x);

function elementToRecords(el: Record<string, Json>, unknownTypes: Map<string, number>): ParsedRecord[] {
  const description = cleanText(el.description) ?? "";
  const codes: CanonicalCode[] = [];
  const seen = new Set<string>();
  for (const ci of asArr(el.code_information)) {
    const o = asObj(ci);
    const c = canonicalizeCode(cleanText(o.type), cleanText(o.code));
    if (!c) continue;
    if (!c.knownType) unknownTypes.set(c.type, (unknownTypes.get(c.type) ?? 0) + 1);
    if (!seen.has(`${c.type}:${c.code}`)) {
      seen.add(`${c.type}:${c.code}`);
      codes.push(c);
    }
  }
  const drug = asObj(el.drug_information);

  return asArr(el.standard_charges).map((scRaw) => {
    const sc = asObj(scRaw);
    const rates: NormalizedRate[] = [];
    for (const pRaw of asArr(sc.payers_information)) {
      const p = asObj(pRaw);
      const payerName = cleanText(p.payer_name);
      if (!payerName) continue;
      rates.push({
        payerName,
        planName: cleanText(p.plan_name) ?? "",
        negotiatedDollar: parseAmount(p.standard_charge_dollar),
        negotiatedPercentage: parsePercentage(p.standard_charge_percentage),
        negotiatedAlgorithm: cleanText(p.standard_charge_algorithm),
        medianAllowed: parseAmount(p.median_amount),
        p10Allowed: parseAmount(p["10th_percentile"]),
        p90Allowed: parseAmount(p["90th_percentile"]),
        allowedCount: cleanText(p.count),
        estimatedAmount: parseAmount(p.estimated_amount),
        methodology: normalizeMethodology(p.methodology),
        notes: cleanText(p.additional_payer_notes),
      });
    }
    return {
      item: {
        description,
        codes,
        setting: normalizeSetting(sc.setting),
        billingClass: normalizeBillingClass(sc.billing_class),
        modifiers: Array.isArray(sc.modifier_code) ? asStrings(sc.modifier_code).map((m) => m.toUpperCase()) : splitModifiers(sc.modifiers),
        drugUnit: parseAmount(drug.unit),
        drugUnitType: cleanText(drug.type)?.toUpperCase() ?? null,
        gross: parseAmount(sc.gross_charge),
        discountedCash: parseAmount(sc.discounted_cash),
        minNegotiated: parseAmount(sc.minimum),
        maxNegotiated: parseAmount(sc.maximum),
        notes: cleanText(sc.additional_generic_notes),
      },
      rates,
    };
  });
}

export async function parseJson(input: Readable): Promise<ParseResult> {
  const meta = emptyMeta("json");
  const warnings: string[] = [];
  const unknownTypes = new Map<string, number>();
  const tokens = input.pipe(parser.asStream({ packValues: true, streamValues: false }));

  const applyMeta = (k: string, v: Json) => {
    switch (k) {
      case "hospital_name":
        meta.hospitalName = cleanText(v);
        break;
      case "last_updated_on":
        meta.lastUpdatedOn = normalizeDate(v);
        break;
      case "version":
        meta.templateVersion = cleanText(v);
        break;
      case "location_name":
      case "hospital_location":
        meta.locationNames = asStrings(v);
        break;
      case "hospital_address":
        meta.addresses = asStrings(v);
        break;
      case "type_2_npi":
        meta.type2Npis = asStrings(v);
        break;
      case "financial_aid_policy":
        meta.financialAidPolicy = cleanText(v);
        break;
      case "license_information": {
        const o = asObj(v);
        meta.licenseNumber = cleanText(o.license_number);
        meta.licenseState = cleanText(o.state)?.toUpperCase() ?? null;
        break;
      }
      case "attestation": // v3
      case "affirmation": {
        // v2
        const o = asObj(v);
        meta.attestation = parseBool(o.confirm_attestation ?? o.confirm_affirmation);
        meta.attesterName = cleanText(o.attester_name) ?? meta.attesterName;
        break;
      }
    }
  };

  async function* records(): AsyncGenerator<ParsedRecord> {
    let depth = 0;
    let topKey: string | null = null;
    let inCharges = false;
    let asm: ValueAssembler | null = null;
    let sawCharges = false;

    try {
      for await (const t of tokens as AsyncIterable<Token>) {
        if (asm) {
          asm.consume(t);
          if (!asm.done) continue;
          const value = asm.current;
          asm = null;
          if (inCharges) {
            for (const rec of elementToRecords(asObj(value), unknownTypes)) yield rec;
          } else if (topKey) {
            applyMeta(topKey, value);
          }
          continue;
        }

        if (depth === 0) {
          if (t.name !== "startObject") throw new Error("JSON MRF must be an object at the top level");
          depth = 1;
        } else if (depth === 1) {
          if (t.name === "keyValue") topKey = t.value as string;
          else if (t.name === "endObject") depth = 0;
          else if (topKey === "standard_charge_information" && t.name === "startArray") {
            inCharges = true;
            sawCharges = true;
            depth = 2;
          } else {
            asm = new ValueAssembler();
            asm.consume(t);
            if (asm.done) {
              applyMeta(topKey ?? "", asm.current);
              asm = null;
            }
          }
        } else if (depth === 2) {
          if (t.name === "endArray") {
            inCharges = false;
            depth = 1;
          } else {
            asm = new ValueAssembler();
            asm.consume(t);
            if (asm.done) asm = null; // a bare primitive in the array: not a valid element, skip it
          }
        }
      }
      if (!sawCharges) warnings.push("No standard_charge_information array found");
    } finally {
      for (const [t, n] of unknownTypes) {
        if (warnings.length < MAX_WARNINGS) warnings.push(`Unknown code type "${t}" on ${n} item(s)`);
      }
      tokens.destroy();
    }
  }

  return { meta, records: records(), warnings };
}
