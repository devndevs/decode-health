import { describe, expect, it } from "vitest";
import { type AmountStats, type BenefitInputs, type ComponentPricing, estimateCost, patientShare } from "./estimator";

const stats = (median: number, n = 5): AmountStats => ({
  n,
  min: median * 0.5,
  p25: median * 0.8,
  median,
  p75: median * 1.2,
  max: median * 1.5,
});

const empty: Omit<ComponentPricing, "key"> = { plan: null, payer: null, allPayers: null, cash: null, gross: null };

const ppo: BenefitInputs = {
  deductibleRemaining: 500,
  deductibleApplies: true,
  afterDeductible: { type: "coinsurance", percent: 20 },
  oopMaxRemaining: 4000,
};

describe("patientShare", () => {
  it("applies deductible then coinsurance", () => {
    expect(patientShare(1500, ppo)).toMatchObject({ deductible: 500, costShare: 200, patient: 700, plan: 800 });
  });

  it("never charges more than the allowed amount", () => {
    expect(patientShare(300, ppo)).toMatchObject({ deductible: 300, costShare: 0, patient: 300, plan: 0 });
  });

  it("uses a flat copay when the deductible does not apply", () => {
    const copayVisit: BenefitInputs = { ...ppo, deductibleApplies: false, afterDeductible: { type: "copay", amount: 35 } };
    expect(patientShare(220, copayVisit)).toMatchObject({ deductible: 0, patient: 35, plan: 185 });
    expect(patientShare(20, copayVisit)).toMatchObject({ patient: 20, plan: 0 });
  });

  it("caps at the out-of-pocket maximum", () => {
    expect(patientShare(50_000, { ...ppo, oopMaxRemaining: 1000 })).toMatchObject({ patient: 1000, cappedByOopMax: true });
  });
});

describe("estimateCost", () => {
  it("prefers plan-specific rates and sums components", () => {
    const r = estimateCost({
      coverage: { kind: "insured", benefits: { ...ppo, deductibleRemaining: 0 } },
      components: [
        { key: "CPT:99213", ...empty, plan: stats(100), payer: stats(150), allPayers: stats(200) },
        { key: "HCPCS:G0463", ...empty, plan: stats(200) },
      ],
    });
    expect(r.allowed).toEqual({ low: 240, typical: 300, high: 360 });
    expect(r.patient).toEqual({ low: 48, typical: 60, high: 72 });
    expect(r.confidence).toBe("high");
    expect(r.components.map((c) => c.basis?.source)).toEqual(["plan", "plan"]);
  });

  it("falls back through payer → all payers → gross and lowers confidence", () => {
    const r = estimateCost({
      coverage: { kind: "insured", benefits: ppo },
      components: [
        { key: "a", ...empty, payer: stats(100) },
        { key: "b", ...empty, allPayers: stats(100) },
      ],
    });
    expect(r.confidence).toBe("low");
    expect(r.notes).toEqual(expect.arrayContaining(["using_payer_level_rates", "using_all_payer_rates"]));
  });

  it("uses min–max when there are too few rates for quartiles", () => {
    const r = estimateCost({
      coverage: { kind: "uninsured" },
      components: [{ key: "a", ...empty, cash: stats(100, 2) }],
    });
    expect(r.allowed).toEqual({ low: 50, typical: 100, high: 150 });
  });

  it("uses cash price for uninsured and surfaces rights + assistance", () => {
    const r = estimateCost({
      coverage: { kind: "uninsured" },
      components: [{ key: "a", ...empty, cash: stats(400), gross: stats(1000) }],
    });
    expect(r.patient).toEqual({ low: 320, typical: 400, high: 480 });
    expect(r.notes).toEqual(expect.arrayContaining(["financial_assistance_may_apply", "good_faith_estimate_right"]));
  });

  it("reports $0 for ACA preventive services when insured", () => {
    const r = estimateCost({
      coverage: { kind: "insured", benefits: ppo },
      acaPreventive: true,
      components: [{ key: "a", ...empty, plan: stats(300) }],
    });
    expect(r.patient).toEqual({ low: 0, typical: 0, high: 0 });
    expect(r.notes).toContain("aca_preventive_no_cost");
  });

  it("flags missing components instead of silently under-estimating", () => {
    const r = estimateCost({
      coverage: { kind: "uninsured" },
      components: [
        { key: "facility", ...empty, cash: stats(100) },
        { key: "professional", ...empty },
      ],
    });
    expect(r.missing).toEqual(["professional"]);
    expect(r.confidence).toBe("low");
    expect(r.notes).toContain("missing_components");
  });

  it("returns no estimate when nothing is priced", () => {
    const r = estimateCost({ coverage: { kind: "uninsured" }, components: [{ key: "a", ...empty }] });
    expect(r.allowed).toBeNull();
    expect(r.patient).toBeNull();
  });
});
