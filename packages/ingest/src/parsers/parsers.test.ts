import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseMrfFile, type ParsedRecord } from "./index";

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

async function collect(file: string) {
  const result = await parseMrfFile(file);
  const records: ParsedRecord[] = [];
  for await (const r of result.records) records.push(r);
  return { meta: result.meta, warnings: result.warnings, records };
}

const byCode = (records: ParsedRecord[], code: string) =>
  records.filter((r) => r.item.codes.some((c) => c.code === code) && r.item.modifiers.length === 0);

describe("CSV tall v3", () => {
  it("reads general data elements", async () => {
    const { meta } = await collect(fixture("v3-tall.csv"));
    expect(meta).toMatchObject({
      format: "csv_tall",
      templateVersion: "3.0.0",
      hospitalName: "Example General Hospital",
      lastUpdatedOn: "2026-07-01",
      licenseState: "CA",
      licenseNumber: "000000001",
      type2Npis: ["1234567893"],
      attesterName: "Pat Example",
      attestation: true,
    });
  });

  it("normalizes items, codes, and rates", async () => {
    const { records } = await collect(fixture("v3-tall.csv"));
    const mri = byCode(records, "73721");
    expect(mri).toHaveLength(4);
    expect(mri[0]!.item).toMatchObject({ gross: 3200, discountedCash: 1100, setting: "outpatient", billingClass: "facility" });
    // labelled HCPCS in the file, stored as CPT
    expect(mri[0]!.item.codes).toEqual([
      { type: "CPT", code: "73721", knownType: true },
      { type: "CDM", code: "12345", knownType: true },
    ]);
    expect(mri.map((r) => r.rates[0]!.payerName)).toEqual([
      "Aetna Life Insurance Co",
      "Blue Shield of California",
      "Anthem Blue Cross",
      "UnitedHealthcare",
    ]);

    const clinic = byCode(records, "G0463");
    expect(clinic[0]!.item.codes[0]).toMatchObject({ type: "HCPCS", code: "G0463" });
    expect(clinic[0]!.rates[0]).toMatchObject({
      negotiatedPercentage: 55,
      medianAllowed: 300,
      p10Allowed: 250,
      p90Allowed: 380,
      allowedCount: "25",
      methodology: "percent of total billed charges",
    });
  });

  it("keeps cash-only rows with no rates, and drug details", async () => {
    const { records } = await collect(fixture("v3-tall.csv"));
    expect(byCode(records, "80048")[0]!.rates).toEqual([]);
    const drug = byCode(records, "J2405")[0]!;
    expect(drug.item).toMatchObject({ drugUnit: 1, drugUnitType: "UN", setting: "both", notes: null });
    expect(drug.item.codes.map((c) => c.type)).toEqual(["HCPCS", "NDC"]);
  });

  it("keeps modifiers", async () => {
    const { records } = await collect(fixture("v3-tall.csv"));
    const pro = records.find((r) => r.item.modifiers.includes("26"));
    expect(pro?.item.description).toMatch(/PROFESSIONAL/);
  });
});

describe("CSV wide v3", () => {
  it("expands payer columns into rates", async () => {
    const { meta, records } = await collect(fixture("v3-wide.csv"));
    expect(meta).toMatchObject({
      format: "csv_wide",
      lastUpdatedOn: "2026-07-01",
      locationNames: ["Example General Hospital", "Example North Clinic"],
      type2Npis: ["1234567893", "1234567901"],
    });
    expect(records).toHaveLength(4);
    const clinic = byCode(records, "G0463")[0]!;
    expect(clinic.rates).toHaveLength(2);
    expect(clinic.rates[0]).toMatchObject({
      payerName: "Aetna Life Insurance Co",
      planName: "Aetna PPO",
      negotiatedPercentage: 55,
      medianAllowed: 300,
      notes: "Paid at 55% of charges",
    });
    expect(clinic.rates[1]).toMatchObject({ payerName: "Blue Shield of California", negotiatedDollar: 280 });
    expect(byCode(records, "80048")[0]!.rates).toEqual([]);
  });
});

describe("CSV tall v2", () => {
  it("reads v2 headers including estimated_amount", async () => {
    const { meta, records } = await collect(fixture("v2-tall.csv"));
    expect(meta).toMatchObject({ templateVersion: "2.2.0", locationNames: ["Example General Hospital"], attestation: true });
    expect(byCode(records, "G0463")[0]!.rates[0]).toMatchObject({ negotiatedPercentage: 55, estimatedAmount: 310 });
    expect(byCode(records, "73721")[0]!.item.notes).toBeNull();
  });
});

describe("JSON v3", () => {
  it("streams standard_charge_information and reads metadata on either side of it", async () => {
    const { meta, records } = await collect(fixture("v3.json"));
    expect(meta).toMatchObject({
      format: "json",
      templateVersion: "3.0.0",
      licenseNumber: "000000001",
      attestation: true,
      attesterName: "Pat Example",
    });
    expect(records).toHaveLength(3);
    expect(records[0]!.item.codes).toEqual([
      { type: "CPT", code: "99213", knownType: true },
      { type: "RC", code: "0510", knownType: true },
    ]);
    expect(records[1]!.rates[0]).toMatchObject({ medianAllowed: 300, allowedCount: "25" });
    expect(records[2]!.item).toMatchObject({ modifiers: ["JW"], drugUnit: 1, drugUnitType: "UN" });
  });
});

describe("compressed and re-encoded input", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "mrf-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads gzipped JSON", async () => {
    const gz = path.join(dir, "file.json.gz");
    await writeFile(gz, gzipSync(await readFile(fixture("v3.json"))));
    const { records } = await collect(gz);
    expect(records).toHaveLength(3);
  });

  it("reads UTF-16LE CSV with BOM", async () => {
    const f = path.join(dir, "utf16.csv");
    const text = await readFile(fixture("v2-tall.csv"), "utf8");
    await writeFile(f, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]));
    const { meta, records } = await collect(f);
    expect(meta.hospitalName).toBe("Example General Hospital");
    expect(records).toHaveLength(2);
  });

  it("rejects files that are not CMS templates", async () => {
    const f = path.join(dir, "bad.csv");
    await writeFile(f, "a,b\n1,2\nx,y\n");
    await expect(parseMrfFile(f)).rejects.toThrow(/description/);
  });
});
