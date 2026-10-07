/**
 * Payer and plan matching.
 *
 * Every hospital spells payers differently ("AETNA", "Aetna Life Ins Co",
 * "Aetna - Commercial"), and plan names are free text. We store each distinct
 * raw (payer, plan) pair once, then resolve it to a canonical payer + a product
 * type (HMO, PPO, Medi-Cal, ...). Users pick "Blue Shield PPO", not one of the
 * 40 spellings in a hospital file.
 *
 * Anything we can't match lands in a review queue (`pnpm ingest payers:unmatched`);
 * fixing an alias in data/payers/payers.json re-resolves every stored rate
 * without re-ingesting the hospital file.
 */

export const PRODUCT_TYPES = [
  "hmo",
  "ppo",
  "epo",
  "pos",
  "hdhp",
  "exchange",
  "medicare_advantage",
  "medicare",
  "medi_cal",
  "tricare",
  "workers_comp",
  "all",
  "other",
] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

const LEGAL_SUFFIXES = new Set(["inc", "llc", "co", "corp", "corporation", "company", "ltd", "the"]);

/**
 * Lowercase, strip punctuation and trailing legal suffixes, collapse whitespace.
 * Bracketed numeric IDs are dropped: UC San Diego writes "AETNA [1003]", where the
 * number is its internal contract ID, not part of the payer's name.
 */
export function normalizeName(raw: string | null | undefined): string {
  const tokens = (raw ?? "")
    .replace(/\[\s*\d+\s*\]/g, " ")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1]!)) tokens.pop();
  return tokens.join(" ");
}

export interface PayerAliasSource {
  slug: string;
  name: string;
  aliases: string[];
  /**
   * Allow "<alias> <anything>" to match. Off for generic program names: we don't
   * want "Medicare Advantage – Humana" filed under traditional Medicare.
   */
  prefixMatch?: boolean;
}

export interface PayerIndex {
  exact: Map<string, string>;
  /** [normalizedAlias, slug], longest alias first so "blue shield promise" beats "blue shield". */
  prefixes: Array<[string, string]>;
}

export function buildPayerIndex(payers: PayerAliasSource[]): PayerIndex {
  const exact = new Map<string, string>();
  const noPrefix = new Set(payers.filter((p) => p.prefixMatch === false).map((p) => p.slug));
  for (const p of payers) {
    for (const alias of [p.name, p.slug.replace(/-/g, " "), ...p.aliases]) {
      const key = normalizeName(alias);
      if (!key) continue;
      const existing = exact.get(key);
      if (existing && existing !== p.slug) {
        throw new Error(`Payer alias "${alias}" maps to both ${existing} and ${p.slug}`);
      }
      exact.set(key, p.slug);
    }
  }
  const prefixes = [...exact.entries()].filter(([, slug]) => !noPrefix.has(slug)).sort((a, b) => b[0].length - a[0].length);
  return { exact, prefixes };
}

export type MatchMethod = "exact" | "prefix";

export function matchPayer(raw: string, index: PayerIndex): { slug: string; method: MatchMethod } | null {
  const key = normalizeName(raw);
  if (!key) return null;
  const hit = index.exact.get(key);
  if (hit) return { slug: hit, method: "exact" };
  for (const [alias, slug] of index.prefixes) {
    if (key.startsWith(alias + " ")) return { slug, method: "prefix" };
  }
  return null;
}

/**
 * Best-effort product type from a free-text plan name (and payer name, since
 * some hospitals put "Medi-Cal" in the payer column). Order matters: government
 * programs are checked before network types because "Medicare HMO" is a
 * Medicare Advantage plan, not a commercial HMO.
 */
export function inferProductType(planName: string | null | undefined, payerName?: string | null): ProductType {
  const plan = ` ${normalizeName(planName)} `;
  const both = ` ${normalizeName(`${payerName ?? ""} ${planName ?? ""}`)} `;
  const has = (s: string, ...words: string[]) => words.some((w) => s.includes(` ${w} `));

  // "MediCal" normalizes to "medical", which is ambiguous, so only accept it in an unambiguous phrase.
  if (has(both, "medi cal", "medicaid", "mcal", "medical managed care", "managed medical")) return "medi_cal";
  if (
    has(both, "medicare advantage", "medicare adv", "mapd", "ma pd", "dsnp", "d snp", "snp") ||
    (has(both, "medicare") && has(both, "hmo", "ppo", "pos", "advantage", "senior"))
  ) {
    return "medicare_advantage";
  }
  if (has(both, "medicare")) return "medicare";
  if (has(both, "tricare", "triwest", "champus", "va community care")) return "tricare";
  if (has(both, "workers comp", "workers compensation", "work comp", "wc")) return "workers_comp";
  if (has(plan, "covered california", "exchange", "marketplace", "ifp", "individual and family", "on exchange")) return "exchange";
  if (has(plan, "hdhp", "high deductible")) return "hdhp";
  if (has(plan, "epo")) return "epo";
  if (has(plan, "pos", "point of service")) return "pos";
  if (has(plan, "hmo")) return "hmo";
  if (has(plan, "ppo")) return "ppo";
  if (has(plan, "all plans", "all products", "all lines", "all lob", "all", "commercial all")) return "all";
  return "other";
}
