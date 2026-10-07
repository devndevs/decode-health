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
 * Pick this hospital's file(s). `match` terms are case-insensitive substrings of
 * location-name. With no terms, a single-entry file is accepted as-is.
 *
 * Every distinct mrf-url that matches is treated as one part of the hospital's
 * file (UC San Diego splits its file into 33 parts), so keep match terms
 * specific enough not to pull in another hospital's file. The loader also warns
 * when a file's own hospital name doesn't match.
 */
export function selectEntries(entries: HptEntry[], match: string[]): HptEntry[] {
  const terms = match.map((m) => m.toLowerCase());
  const hits = terms.length
    ? entries.filter((e) => terms.some((t) => e.locationName.toLowerCase().includes(t)))
    : entries.length === 1
      ? entries
      : [];
  const seen = new Set<string>();
  const unique = hits.filter((h) => !seen.has(h.mrfUrl) && seen.add(h.mrfUrl));
  if (unique.length) return unique;
  const names = entries.map((e) => `"${e.locationName}"`).join(", ");
  throw new Error(`No cms-hpt.txt entry matched ${JSON.stringify(match)}. Locations listed: ${names}`);
}
