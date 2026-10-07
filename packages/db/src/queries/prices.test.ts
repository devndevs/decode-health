import { describe, expect, it } from "vitest";
import { mergeStats } from "./prices";

describe("mergeStats", () => {
  it("passes a single row through", () => {
    const r = { n: 3, min: 1, p25: 2, median: 3, p75: 4, max: 5 };
    expect(mergeStats([r])).toEqual(r);
  });

  it("spans every row and weights the median by count", () => {
    expect(
      mergeStats([
        { n: 1, min: 16.5, p25: 16.5, median: 16.5, p75: 16.5, max: 16.5 },
        { n: 3, min: 400, p25: 450, median: 493.35, p75: 500, max: 600 },
      ]),
    ).toEqual({ n: 4, min: 16.5, p25: 16.5, median: 374.14, p75: 500, max: 600 });
  });

  it("returns null for nothing", () => {
    expect(mergeStats([])).toBeNull();
  });
});
