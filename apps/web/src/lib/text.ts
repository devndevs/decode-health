import type { LocalizedText } from "@decode-health/core";

/** Replace {name} placeholders. */
export function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** Pick the right language from a {en, es} field, falling back to English. */
export function pick(text: LocalizedText | null | undefined, locale: string): string {
  if (!text) return "";
  return (locale === "es" && text.es) || text.en;
}
