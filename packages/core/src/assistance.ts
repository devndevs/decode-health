/**
 * Federal poverty level (FPL) math and the financial-help screener.
 *
 * Program rules live in data/resources/programs.json, not here, so a
 * non-developer can update a threshold when a law changes. This module only
 * evaluates them. Results are always phrased as "you may qualify" — the
 * program itself makes the real determination.
 */
import type { Program, PovertyGuideline } from "./registry";

export function povertyLine(g: PovertyGuideline, householdSize: number): number {
  const size = Math.max(1, Math.floor(householdSize));
  return g.firstPerson + g.eachAdditional * (size - 1);
}

/** Income as a percent of the poverty line, rounded down to a whole percent (how most programs compare). */
export function percentOfPoverty(annualIncome: number, householdSize: number, g: PovertyGuideline): number {
  if (annualIncome <= 0) return 0;
  return Math.floor((annualIncome / povertyLine(g, householdSize)) * 100);
}

export interface ScreenerAnswers {
  householdSize: number;
  annualIncome: number;
  age?: number;
  pregnant?: boolean;
  insured: boolean;
  /** Region path of where the person lives, e.g. "ca/ca-socal/ca-san-diego-county". */
  regionPath?: string;
}

export interface ScreenerMatch {
  program: Program;
  /** True when every rule the program states was checked and passed; false when we lacked an answer (e.g. age). */
  definite: boolean;
}

export interface ScreenerResult {
  fplPercent: number;
  guidelineYear: number;
  matches: ScreenerMatch[];
}

export function screenPrograms(programs: Program[], answers: ScreenerAnswers, g: PovertyGuideline): ScreenerResult {
  const fplPercent = percentOfPoverty(answers.annualIncome, answers.householdSize, g);
  const regionSegments = new Set((answers.regionPath ?? "").split("/").filter(Boolean));
  const matches: ScreenerMatch[] = [];

  for (const program of programs) {
    if (answers.regionPath && !program.regions.some((r) => regionSegments.has(r))) continue;

    const e = program.eligibility;
    if (!e) {
      matches.push({ program, definite: true });
      continue;
    }

    let definite = true;
    if (e.maxFplPercent != null && fplPercent > e.maxFplPercent) continue;
    if (e.minFplPercent != null && fplPercent < e.minFplPercent) continue;
    if (e.uninsuredOnly && answers.insured) continue;
    if (e.pregnantOnly) {
      if (answers.pregnant === false) continue;
      if (answers.pregnant == null) definite = false;
    }
    if (e.minAge != null || e.maxAge != null) {
      if (answers.age == null) definite = false;
      else if ((e.minAge != null && answers.age < e.minAge) || (e.maxAge != null && answers.age > e.maxAge)) continue;
    }
    matches.push({ program, definite });
  }

  return { fplPercent, guidelineYear: g.year, matches };
}
