import { describe, expect, it } from "vitest";
import { effectiveAmount, isSentinelAmount, parseAmount, type NormalizedRate } from "./charges";

describe("parseAmount", () => {
  it("accepts lenient formats", () => {
    expect(parseAmount("$1,234.50")).toBe(1234.5);
    expect(parseAmount(42)).toBe(42);
  });

  it("treats blanks, zero, negatives, and N/A as missing", () => {
    for (const v of ["", "N/A", "0", -5, 0, null, undefined]) expect(parseAmount(v)).toBeNull();
  });

  it("treats all-nines 'insufficient data' sentinels as missing", () => {
    expect(parseAmount(999999999)).toBeNull();
    expect(parseAmount("999999999")).toBeNull();
    expect(parseAmount(9999999.99)).toBeNull();
    expect(isSentinelAmount(999999)).toBe(false);
  });

  it("keeps legitimate multi-million charges", () => {
    expect(parseAmount(12_750_000)).toBe(12_750_000);
    expect(parseAmount(9_500_000)).toBe(9_500_000);
  });
});

describe("effectiveAmount", () => {
  const rate = (r: Partial<NormalizedRate>): NormalizedRate => ({
    payerName: "P",
    planName: "",
    negotiatedDollar: null,
    negotiatedPercentage: null,
    negotiatedAlgorithm: null,
    medianAllowed: null,
    p10Allowed: null,
    p90Allowed: null,
    allowedCount: null,
    estimatedAmount: null,
    methodology: null,
    notes: null,
    ...r,
  });

  it("prefers dollars, then allowed amounts, then estimates, then % of charges", () => {
    expect(effectiveAmount(rate({ negotiatedDollar: 100, medianAllowed: 90 }), { gross: 500 })).toEqual({ amount: 100, basis: "negotiated_dollar" });
    expect(effectiveAmount(rate({ medianAllowed: 90 }), { gross: 500 })).toEqual({ amount: 90, basis: "median_allowed" });
    expect(
      effectiveAmount(rate({ negotiatedPercentage: 50, methodology: "percent of total billed charges" }), { gross: 500 }),
    ).toEqual({ amount: 250, basis: "percent_of_gross" });
  });

  it("drops rates implausibly low relative to the list price", () => {
    expect(effectiveAmount(rate({ negotiatedDollar: 0.67, methodology: "other" }), { gross: 26_336 })).toBeNull();
    expect(effectiveAmount(rate({ negotiatedDollar: 0.67 }), { gross: null })).toEqual({ amount: 0.67, basis: "negotiated_dollar" });
  });

  it("uses only allowed amounts for per-diem rates", () => {
    expect(effectiveAmount(rate({ negotiatedDollar: 3000, methodology: "per diem" }), { gross: 90_000 })).toBeNull();
    expect(effectiveAmount(rate({ negotiatedDollar: 3000, medianAllowed: 21_000, methodology: "per diem" }), { gross: 90_000 })).toEqual({
      amount: 21_000,
      basis: "median_allowed",
    });
  });
});
