import { describe, expect, it } from "vitest";
import { canonicalizeCode } from "./codes";

describe("canonicalizeCode", () => {
  it("re-labels CPT-shaped codes filed under HCPCS, and vice versa", () => {
    expect(canonicalizeCode("HCPCS", "73721")).toMatchObject({ type: "CPT", code: "73721" });
    expect(canonicalizeCode("CPT", "g0463")).toMatchObject({ type: "HCPCS", code: "G0463" });
    expect(canonicalizeCode("hcpcs", "0001U")).toMatchObject({ type: "CPT", code: "0001U" });
  });

  it("pads DRGs and revenue codes", () => {
    expect(canonicalizeCode("MS-DRG", "70")).toMatchObject({ type: "MS-DRG", code: "070" });
    expect(canonicalizeCode("MSDRG", "DRG470")).toMatchObject({ type: "MS-DRG", code: "470" });
    expect(canonicalizeCode("APR-DRG", "139-2")).toMatchObject({ type: "APR-DRG", code: "139-2" });
    expect(canonicalizeCode("RC", "610")).toMatchObject({ type: "RC", code: "0610" });
    expect(canonicalizeCode("Revenue Code", "450")).toMatchObject({ type: "RC", code: "0450" });
  });

  it("keeps unknown types but flags them", () => {
    expect(canonicalizeCode("SNOMED", "123")).toEqual({ type: "SNOMED", code: "123", knownType: false });
  });

  it("returns null for blank codes", () => {
    expect(canonicalizeCode("CPT", "  ")).toBeNull();
    expect(canonicalizeCode("CPT", undefined)).toBeNull();
  });
});
