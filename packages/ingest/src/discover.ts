/**
 * Discovery via cms-hpt.txt.
 *
 * Since 2024, every hospital must publish a plain-text index at the root of its
 * website listing each location's machine-readable file:
 *
 *   location-name: UC San Diego Health – Hillcrest
 *   source-page-url: https://example.org/price-transparency
 *   mrf-url: https://example.org/files/123456789_hillcrest_standardcharges.csv
 *   contact-name: Jane Doe
 *   contact-email: jane@example.org
 *
 * This is what lets us scale from one hospital to hundreds without hand-copying
 * file URLs (which hospitals change every time they republish).
 */

export interface HptEntry {
  locationName: string;
  sourcePageUrl: string | null;
  mrfUrl: string;
  contactName: string | null;
  contactEmail: string | null;
}

export function parseCmsHptTxt(text: string): HptEntry[] {
  const entries: HptEntry[] = [];
  let cur: Partial<Record<string, string>> = {};
  const flush = () => {
    if (cur["location-name"] && cur["mrf-url"]) {
      entries.push({
        locationName: cur["location-name"],
        sourcePageUrl: cur["source-page-url"] ?? null,
        mrfUrl: cur["mrf-url"],
        contactName: cur["contact-name"] ?? null,
        contactEmail: cur["contact-email"] ?? null,
      });
    }
    cur = {};
  };

  for (const rawLine of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      flush();
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "location-name" && cur["location-name"]) flush(); // blocks without a blank line between them
    cur[key] = value;
  }
  flush();
  return entries;
}

/**
 * Pick this hospital's file. `match` terms are case-insensitive substrings of
 * location-name. With no terms, a single-entry file is accepted as-is.
 */
export function selectEntry(entries: HptEntry[], match: string[]): HptEntry {
  const terms = match.map((m) => m.toLowerCase());
  const hits = terms.length
    ? entries.filter((e) => terms.some((t) => e.locationName.toLowerCase().includes(t)))
    : entries.length === 1
      ? entries
      : [];
  const urls = [...new Set(hits.map((h) => h.mrfUrl))];
  if (urls.length === 1) return hits[0]!;
  const names = entries.map((e) => `"${e.locationName}"`).join(", ");
  if (!urls.length) throw new Error(`No cms-hpt.txt entry matched ${JSON.stringify(match)}. Locations listed: ${names}`);
  throw new Error(`${urls.length} different files matched ${JSON.stringify(match)}; narrow locationNameMatch. Locations listed: ${names}`);
}
