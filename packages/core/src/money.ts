const formatters = new Map<string, Intl.NumberFormat>();

/** Whole-dollar USD, localized ("$1,234" / "1234 US$"). Ballpark figures don't need cents. */
export function formatUSD(amount: number, locale = "en"): string {
  let f = formatters.get(locale);
  if (!f) {
    f = new Intl.NumberFormat(locale === "es" ? "es-US" : "en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    });
    formatters.set(locale, f);
  }
  return f.format(Math.round(amount));
}

export function formatUSDRange(low: number, high: number, locale = "en"): string {
  return Math.round(low) === Math.round(high)
    ? formatUSD(low, locale)
    : `${formatUSD(low, locale)} – ${formatUSD(high, locale)}`;
}
