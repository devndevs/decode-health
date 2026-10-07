/**
 * Writes parsed records into a work directory in the format the loader expects
 * (see WORK_FILES in @decode-health/db). Streaming and backpressure-aware, so a
 * 10 GB hospital file is processed in constant memory.
 */
import { createHash } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import { effectiveAmount, type NormalizedItem, type NormalizedRate } from "@decode-health/core";
import {
  META_FILE,
  PAYER_PLANS_FILE,
  WORK_FILES,
  type FileMeta,
  type ParseStats,
  type PayerPlanEntry,
  type WorkDirManifest,
} from "@decode-health/db";
import { MAX_WARNINGS, type ParseResult } from "./parsers/types";

type Cell = string | number | null | undefined;

/** Postgres COPY CSV: empty unquoted = NULL; text is always quoted; newlines and NULs removed. */
function cell(v: Cell): string {
  if (v == null) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  return `"${v.replace(/\u0000/g, "").replace(/[\r\n]+/g, " ").replace(/"/g, '""')}"`;
}

function pgArray(values: string[]): string {
  const safe = values.filter((v) => /^[A-Z0-9]+$/.test(v));
  return `"{${safe.join(",")}}"`;
}

class CsvOut {
  private stream: WriteStream;
  constructor(file: string, columns: readonly string[]) {
    this.stream = createWriteStream(file);
    this.stream.write(columns.join(",") + "\n");
  }
  async row(cells: string[]) {
    if (!this.stream.write(cells.join(",") + "\n")) await once(this.stream, "drain");
  }
  async close() {
    this.stream.end();
    await once(this.stream, "finish");
  }
}

/** Tall files repeat the item on every payer row. Rows for one item are usually adjacent, so a bounded LRU catches them. */
const ITEM_CACHE_SIZE = 100_000;

export class WorkDirWriter {
  private items!: CsvOut;
  private codes!: CsvOut;
  private rates!: CsvOut;
  private itemSeq = 0;
  private recentItems = new Map<string, number>();
  private payerPlans = new Map<string, number>();
  readonly stats: ParseStats = {
    rowsRead: 0,
    items: 0,
    codes: 0,
    rates: 0,
    payerPlans: 0,
    unknownCodeTypes: {},
    itemsWithoutCodes: 0,
    ratesWithoutAmount: 0,
    warnings: [],
  };

  constructor(readonly dir: string) {}

  async open() {
    await mkdir(this.dir, { recursive: true });
    this.items = new CsvOut(path.join(this.dir, WORK_FILES.items.file), WORK_FILES.items.columns);
    this.codes = new CsvOut(path.join(this.dir, WORK_FILES.codes.file), WORK_FILES.codes.columns);
    this.rates = new CsvOut(path.join(this.dir, WORK_FILES.rates.file), WORK_FILES.rates.columns);
  }

  private itemKey(item: NormalizedItem): string {
    return createHash("sha1").update(JSON.stringify(item)).digest("base64");
  }

  private payerPlanId(payerName: string, planName: string): number {
    const k = `${payerName}\u0000${planName}`;
    let id = this.payerPlans.get(k);
    if (id == null) {
      id = this.payerPlans.size + 1;
      this.payerPlans.set(k, id);
    }
    return id;
  }

  async add(item: NormalizedItem, rates: NormalizedRate[]) {
    this.stats.rowsRead++;
    const key = this.itemKey(item);
    let itemId = this.recentItems.get(key);
    if (itemId == null) {
      itemId = ++this.itemSeq;
      this.recentItems.set(key, itemId);
      if (this.recentItems.size > ITEM_CACHE_SIZE) this.recentItems.delete(this.recentItems.keys().next().value!);
      await this.items.row([
        cell(itemId),
        cell(item.description),
        cell(item.setting),
        cell(item.billingClass),
        pgArray(item.modifiers),
        cell(item.drugUnit),
        cell(item.drugUnitType),
        cell(item.gross),
        cell(item.discountedCash),
        cell(item.minNegotiated),
        cell(item.maxNegotiated),
        cell(item.notes),
      ]);
      this.stats.items++;
      if (!item.codes.length) this.stats.itemsWithoutCodes++;
      for (const c of item.codes) {
        await this.codes.row([cell(itemId), cell(c.type), cell(c.code)]);
        this.stats.codes++;
        if (!c.knownType) this.stats.unknownCodeTypes[c.type] = (this.stats.unknownCodeTypes[c.type] ?? 0) + 1;
      }
    }

    for (const r of rates) {
      const eff = effectiveAmount(r, item);
      if (!eff) this.stats.ratesWithoutAmount++;
      await this.rates.row([
        // Must stay the first column: the loader rewrites it line-by-line.
        String(this.payerPlanId(r.payerName, r.planName)),
        cell(itemId),
        cell(r.negotiatedDollar),
        cell(r.negotiatedPercentage),
        cell(r.negotiatedAlgorithm),
        cell(r.medianAllowed),
        cell(r.p10Allowed),
        cell(r.p90Allowed),
        cell(r.allowedCount),
        cell(r.estimatedAmount),
        cell(r.methodology),
        cell(eff?.amount),
        cell(eff?.basis),
        cell(r.notes),
      ]);
      this.stats.rates++;
    }
  }

  async close(meta: FileMeta, warnings: string[]): Promise<WorkDirManifest> {
    await Promise.all([this.items.close(), this.codes.close(), this.rates.close()]);
    const entries: PayerPlanEntry[] = [...this.payerPlans].map(([k, id]) => {
      const [payer, plan] = k.split("\u0000");
      return [id, payer!, plan!];
    });
    this.stats.payerPlans = entries.length;
    this.stats.warnings = warnings.slice(0, MAX_WARNINGS);
    const manifest: WorkDirManifest = { meta, stats: this.stats, parsedAt: new Date().toISOString() };
    await writeFile(path.join(this.dir, PAYER_PLANS_FILE), JSON.stringify(entries));
    await writeFile(path.join(this.dir, META_FILE), JSON.stringify(manifest, null, 2));
    return manifest;
  }
}

/**
 * Drain one or more ParseResults into a single work directory. Multi-part files
 * (one hospital's prices split across several files) become one version: item
 * ids keep counting across parts, and metadata comes from the first part.
 * Parts are opened lazily, one at a time.
 */
export async function writeWorkDir(
  input: ParseResult | Array<() => Promise<ParseResult>>,
  dir: string,
  onProgress?: (rows: number) => void,
): Promise<WorkDirManifest> {
  const parts = Array.isArray(input) ? input : [async () => input];
  const w = new WorkDirWriter(dir);
  await w.open();
  let meta: FileMeta | null = null;
  const warnings: string[] = [];
  for (const [i, open] of parts.entries()) {
    const result = await open();
    for await (const { item, rates } of result.records) {
      await w.add(item, rates);
      if (onProgress && w.stats.rowsRead % 250_000 === 0) onProgress(w.stats.rowsRead);
    }
    const prefix = parts.length > 1 ? `part ${i + 1}: ` : "";
    warnings.push(...result.warnings.map((x) => prefix + x));
    if (!meta) meta = result.meta;
    else {
      if (result.meta.hospitalName !== meta.hospitalName || result.meta.lastUpdatedOn !== meta.lastUpdatedOn) {
        warnings.push(
          `${prefix}hospital/date "${result.meta.hospitalName} ${result.meta.lastUpdatedOn}" differs from part 1 ` +
            `"${meta.hospitalName} ${meta.lastUpdatedOn}" — are these really parts of the same file?`,
        );
      }
      meta.locationNames = [...new Set([...meta.locationNames, ...result.meta.locationNames])];
      meta.addresses = [...new Set([...meta.addresses, ...result.meta.addresses])];
    }
  }
  if (!meta) throw new Error("writeWorkDir needs at least one part");
  return w.close(meta, warnings);
}
