import "server-only";
import { notFound } from "next/navigation";
import en from "../messages/en.json";
import es from "../messages/es.json";
import { isLocale, type Locale } from "./locales";

export type Dictionary = typeof en;

// Typing `es` as Dictionary makes a missing Spanish key a compile error.
const dictionaries: Record<Locale, Dictionary> = { en, es };

export function getDictionary(locale: Locale): Dictionary {
  return dictionaries[locale];
}

/** Resolve the [locale] route param or 404. */
export async function resolveLocale(params: Promise<{ locale: string }>): Promise<{ locale: Locale; t: Dictionary }> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return { locale, t: getDictionary(locale) };
}

export { fmt, pick } from "./text";
