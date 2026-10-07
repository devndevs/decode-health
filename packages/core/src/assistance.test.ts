import { describe, expect, it } from "vitest";
import { percentOfPoverty, povertyLine, screenPrograms } from "./assistance";
import type { PovertyGuideline, Program } from "./registry";

const g2025: PovertyGuideline = {
  year: 2025,
  area: "contiguous",
  firstPerson: 15650,
  eachAdditional: 5500,
  source: "https://aspe.hhs.gov/topics/poverty-economic-mobility/poverty-guidelines",
};

const program = (slug: string, eligibility: Program["eligibility"], regions = ["ca"]): Program => ({
  slug,
  kind: "coverage",
  name: { en: slug },
  summary: { en: slug },
  url: "https://example.org",
  regions,
  eligibility,
  verified: false,
  lastReviewed: "2026-10-07",
  sources: ["https://example.org"],
});

describe("poverty math", () => {
  it("matches the 2025 HHS table", () => {
    expect(povertyLine(g2025, 1)).toBe(15650);
    expect(povertyLine(g2025, 4)).toBe(32150);
  });

  it("rounds percent of poverty down", () => {
    expect(percentOfPoverty(21_597, 1, g2025)).toBe(138);
    expect(percentOfPoverty(0, 3, g2025)).toBe(0);
  });
});

describe("screenPrograms", () => {
  const programs = [
    program("medi-cal-adults", { maxFplPercent: 138, minAge: 19, maxAge: 64 }),
    program("hospital-discount", { maxFplPercent: 400 }),
    program("uninsured-only", { uninsuredOnly: true }),
    program("pregnancy", { maxFplPercent: 213, pregnantOnly: true }),
    program("info", null),
    program("other-county", null, ["ca-orange-county"]),
  ];

  it("filters by income, coverage, and region", () => {
    const r = screenPrograms(
      programs,
      { householdSize: 2, annualIncome: 40_000, age: 30, insured: true, regionPath: "ca/ca-socal/ca-san-diego-county" },
      g2025,
    );
    expect(r.fplPercent).toBe(189);
    expect(r.matches.map((m) => m.program.slug)).toEqual(["hospital-discount", "pregnancy", "info"]);
  });

  it("marks matches as not definite when an answer is missing", () => {
    const r = screenPrograms(programs, { householdSize: 1, annualIncome: 15_000, insured: false }, g2025);
    const medi = r.matches.find((m) => m.program.slug === "medi-cal-adults");
    expect(medi?.definite).toBe(false);
  });
});
