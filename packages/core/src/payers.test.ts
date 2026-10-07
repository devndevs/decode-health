import { describe, expect, it } from "vitest";
import { buildPayerIndex, inferProductType, matchPayer, normalizeName } from "./payers";

const index = buildPayerIndex([
  { slug: "aetna", name: "Aetna", aliases: ["Aetna Life Insurance"] },
  { slug: "blue-shield-ca", name: "Blue Shield of California", aliases: ["Blue Shield", "BSC"] },
  { slug: "blue-shield-promise", name: "Blue Shield of California Promise Health Plan", aliases: ["Blue Shield Promise"] },
  { slug: "medicare", name: "Medicare", aliases: ["Original Medicare"], prefixMatch: false },
]);

describe("normalizeName", () => {
  it("strips punctuation, case, and legal suffixes", () => {
    expect(normalizeName("AETNA LIFE INSURANCE CO.")).toBe("aetna life insurance");
    expect(normalizeName("Blue Shield of California, Inc")).toBe("blue shield of california");
    expect(normalizeName("Medi-Cal")).toBe("medi cal");
  });
});

describe("matchPayer", () => {
  it("matches exact aliases after normalization", () => {
    expect(matchPayer("Aetna Life Insurance Company", index)).toEqual({ slug: "aetna", method: "exact" });
    expect(matchPayer("bsc", index)).toEqual({ slug: "blue-shield-ca", method: "exact" });
  });

  it("prefers the longest alias on prefix matches", () => {
    expect(matchPayer("Blue Shield Promise Medi-Cal", index)).toEqual({ slug: "blue-shield-promise", method: "prefix" });
    expect(matchPayer("Blue Shield Trio HMO", index)).toEqual({ slug: "blue-shield-ca", method: "prefix" });
  });

  it("skips prefix matching for generic program names", () => {
    expect(matchPayer("Medicare", index)).toEqual({ slug: "medicare", method: "exact" });
    expect(matchPayer("Medicare Advantage Humana", index)).toBeNull();
  });

  it("does not match partial words", () => {
    expect(matchPayer("Aetnaxyz", index)).toBeNull();
  });

  it("rejects an alias claimed by two payers", () => {
    expect(() =>
      buildPayerIndex([
        { slug: "a", name: "A", aliases: ["Shared"] },
        { slug: "b", name: "B", aliases: ["shared"] },
      ]),
    ).toThrow(/maps to both/);
  });
});

describe("inferProductType", () => {
  it.each([
    ["Commercial PPO", null, "ppo"],
    ["HMO", null, "hmo"],
    ["Medicare Advantage HMO", null, "medicare_advantage"],
    ["Senior Advantage", "Medicare", "medicare_advantage"],
    ["Medicare HMO", null, "medicare_advantage"],
    ["Traditional", "Medicare", "medicare"],
    ["Managed Medi-Cal", null, "medi_cal"],
    ["Covered California Silver", null, "exchange"],
    ["All Plans", null, "all"],
    ["TRICARE West", null, "tricare"],
    ["Something odd", null, "other"],
  ] as const)("%s / %s → %s", (plan, payer, expected) => {
    expect(inferProductType(plan, payer)).toBe(expected);
  });
});
