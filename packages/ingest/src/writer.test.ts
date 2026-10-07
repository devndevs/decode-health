import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PAYER_PLANS_FILE, WORK_FILES } from "@decode-health/db";
import { parseMrfFile } from "./parsers";
import { writeWorkDir } from "./writer";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

describe("writeWorkDir", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "work-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("dedupes repeated tall rows into one item with many rates", async () => {
    const manifest = await writeWorkDir(await parseMrfFile(fixture("v3-tall.csv")), dir);
    expect(manifest.stats).toMatchObject({ rowsRead: 15, items: 8, rates: 13, payerPlans: 5, ratesWithoutAmount: 0 });

    const items = (await readFile(path.join(dir, WORK_FILES.items.file), "utf8")).trim().split("\n");
    expect(items[0]).toBe(WORK_FILES.items.columns.join(","));
    expect(items).toHaveLength(9);

    const rates = (await readFile(path.join(dir, WORK_FILES.rates.file), "utf8")).trim().split("\n");
    // percent-of-charges rate resolves to the v3 median allowed amount
    expect(rates.find((l) => l.includes('"percent of total billed charges"'))).toContain(',300,"median_allowed",');

    const plans = JSON.parse(await readFile(path.join(dir, PAYER_PLANS_FILE), "utf8"));
    expect(plans).toContainEqual([1, "Aetna Life Insurance Co", "Aetna PPO"]);
  });
});
