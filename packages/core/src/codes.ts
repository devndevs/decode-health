/**
 * Billing code types and canonicalization.
 *
 * Hospital files label the same code inconsistently ("HCPCS" vs "CPT", "MSDRG"
 * vs "MS-DRG", revenue code "610" vs "0610"). Everything that lands in the
 * database goes through `canonicalizeCode` so a search for CPT 73721 finds it
 * no matter how a hospital labelled it.
 */

/** Valid values from the CMS Hospital Price Transparency data dictionary (v2 + v3). */
export const CODE_TYPES = [
  "CPT",
  "NDC",
  "HCPCS",
  "RC",
  "ICD",
  "DRG",
  "MS-DRG",
  "R-DRG",
  "S-DRG",
  "APS-DRG",
  "AP-DRG",
  "APR-DRG",
  "APC",
  "LOCAL",
  "EAPG",
  "HIPPS",
  "CDT",
  "CDM",
  "TRIS-DRG",
  "CMG",
  "MS-LTC-DRG",
] as const;

export type CodeType = (typeof CODE_TYPES)[number];

/**
 * Code types a consumer can actually shop for. These are the ones we build
 * cross-hospital price summaries for; internal codes (CDM, LOCAL, RC) are kept
 * for traceability but never shown as the primary identifier.
 */
export const SHOPPABLE_CODE_TYPES = ["CPT", "HCPCS", "MS-DRG", "APR-DRG", "DRG", "CDT"] as const;
export type ShoppableCodeType = (typeof SHOPPABLE_CODE_TYPES)[number];

const KNOWN = new Set<string>(CODE_TYPES);

const TYPE_ALIASES: Record<string, CodeType> = {
  MSDRG: "MS-DRG",
  "MS DRG": "MS-DRG",
  "MS_DRG": "MS-DRG",
  APRDRG: "APR-DRG",
  "APR DRG": "APR-DRG",
  "APR_DRG": "APR-DRG",
  REV: "RC",
  "REV CODE": "RC",
  "REVENUE CODE": "RC",
  REVCODE: "RC",
  CHARGEMASTER: "CDM",
  "CPT4": "CPT",
  "CPT-4": "CPT",
  "HCPC": "HCPCS",
};

export interface CanonicalCode {
  type: string;
  code: string;
  /** False when the hospital used a code type outside the CMS list. Kept, but counted in ingest stats. */
  knownType: boolean;
}

// CPT: 5 digits, or 4 digits + F (Category II), T (Category III), U (PLA), M (MAAA).
const CPT_PATTERN = /^\d{4}[0-9FTUM]$/;
// HCPCS Level II: a letter A–V followed by 4 digits.
const HCPCS_L2_PATTERN = /^[A-V]\d{4}$/;

function padDigits(code: string, width: number): string {
  return /^\d+$/.test(code) ? code.padStart(width, "0") : code;
}

/**
 * Normalize a (type, code) pair. Returns null when there is no usable code.
 *
 * CPT is technically HCPCS Level I, and hospitals mix the labels freely, so we
 * re-label by shape: anything that looks like CPT is stored as CPT and anything
 * that looks like HCPCS Level II is stored as HCPCS.
 */
export function canonicalizeCode(rawType: string | null | undefined, rawCode: string | null | undefined): CanonicalCode | null {
  const code0 = (rawCode ?? "").trim().toUpperCase().replace(/\s+/g, "");
  if (!code0) return null;

  const t0 = (rawType ?? "").trim().toUpperCase().replace(/\s+/g, " ");
  let type: string = TYPE_ALIASES[t0] ?? t0;
  let code = code0;

  if (type === "CPT" || type === "HCPCS") {
    if (CPT_PATTERN.test(code)) type = "CPT";
    else if (HCPCS_L2_PATTERN.test(code)) type = "HCPCS";
  }

  if (type === "MS-DRG" || type === "DRG" || type === "MS-LTC-DRG") {
    code = padDigits(code.replace(/^(MS-?)?DRG[-:]?/, ""), 3);
  } else if (type === "APR-DRG") {
    // APR-DRG is often "139-2" (DRG + severity). Pad the DRG part only.
    const [base, ...rest] = code.replace(/^APR-?DRG[-:]?/, "").split("-");
    code = [padDigits(base ?? "", 3), ...rest].join("-");
  } else if (type === "RC") {
    code = padDigits(code, 4);
  }

  if (!type) return { type: "UNKNOWN", code, knownType: false };
  return { type, code, knownType: KNOWN.has(type) };
}

export function isShoppable(type: string): type is ShoppableCodeType {
  return (SHOPPABLE_CODE_TYPES as readonly string[]).includes(type);
}
