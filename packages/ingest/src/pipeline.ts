/**
 * Per-hospital ingest: discover → download → parse → load → summarize.
 *
 * Each step is idempotent. Re-running when the hospital hasn't changed its file
 * is cheap (ETag / SHA-256 match → skipped), and a failure leaves the
 * previously loaded data serving untouched.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  latestMrfFile,
  markFailed,
  markParsed,
  recordMrfFile,
  setDiscoveredUrls,
  type HospitalIngestTarget,
  type MrfPart,
  type Pool,
  type WorkDirManifest,
} from "@decode-health/db";
import { loadWorkDir, summarizeHospital } from "@decode-health/db/load";
import { parseCmsHptTxt, selectEntries } from "./discover";
import { downloadFile, fetchText } from "./fetch";
import { parseMrfFile } from "./parsers";
import type { RawStorage } from "./storage";
import { writeWorkDir } from "./writer";

export interface IngestContext {
  pool: Pool;
  storage: RawStorage;
  dataDir: string;
  userAgent: string;
  maxBytes: number;
  maxUncompressedBytes: number;
  log: (msg: string) => void;
}

export type IngestOutcome =
  | { status: "loaded"; mrfFileId: number; rows: number; summaryRows: number; warnings: string[] }
  | { status: "unchanged"; reason: string };

export async function discoverHospital(ctx: IngestContext, h: HospitalIngestTarget): Promise<string[]> {
  if (!h.cms_hpt_txt_url) throw new Error(`${h.slug}: no cmsHptTxtUrl in the registry and no pinned mrfUrls`);
  const entries = selectEntries(parseCmsHptTxt(await fetchText(h.cms_hpt_txt_url, { userAgent: ctx.userAgent })), h.location_name_match);
  const urls = entries.map((e) => e.mrfUrl);
  await setDiscoveredUrls(ctx.pool, h.id, urls, entries[0]?.sourcePageUrl ?? null);
  const names = [...new Set(entries.map((e) => `"${e.locationName}"`))].join(", ");
  ctx.log(`${h.slug}: discovered ${urls.length} file${urls.length === 1 ? "" : "s"} for ${names}`);
  return urls;
}

function extensionFor(url: string, contentType: string | null): string {
  const fromPath = /\.(csv|json|zip|gz)$/i.exec(new URL(url).pathname)?.[0]?.toLowerCase();
  if (fromPath) return fromPath;
  if (contentType?.includes("json")) return ".json";
  if (contentType?.includes("zip")) return ".zip";
  if (contentType?.includes("csv")) return ".csv";
  return ".bin";
}

/** Raw parts are content-addressed, so an unchanged part of a multi-part file is never stored twice. */
function storageKeyFor(h: HospitalIngestTarget, sha256: string, ext: string): string {
  return `raw/${h.region_path}/${h.slug}/${new Date().toISOString().slice(0, 10)}_${sha256.slice(0, 12)}${ext}`;
}

/** Warn when the file's own hospital name doesn't mention any of our match terms (wrong file?). */
function identityWarning(h: HospitalIngestTarget, m: WorkDirManifest): string | null {
  if (!h.location_name_match.length) return null;
  const haystack = [m.meta.hospitalName ?? "", ...m.meta.locationNames].join(" | ").toLowerCase();
  const ok = h.location_name_match.some((t) => haystack.includes(t.toLowerCase()));
  return ok ? null : `File names "${haystack}" — none of ${JSON.stringify(h.location_name_match)}. Check this is the right file.`;
}

/** Parse a stored file version (all of its parts), load it, and summarize. Shared by network and local-file ingest. */
export async function processStoredFile(
  ctx: IngestContext,
  h: HospitalIngestTarget,
  mrfFileId: number,
  parts: MrfPart[],
  opts: { keepWork?: boolean } = {},
): Promise<Extract<IngestOutcome, { status: "loaded" }>> {
  const workDir = path.join(ctx.dataDir, "work", h.slug, String(mrfFileId));
  try {
    const openers = parts.map((part, i) => async () => {
      const local = await ctx.storage.get(part.storageKey);
      ctx.log(`${h.slug}: parsing ${path.basename(local)}${parts.length > 1 ? ` (part ${i + 1}/${parts.length})` : ""}`);
      return parseMrfFile(local, { maxUncompressedBytes: ctx.maxUncompressedBytes });
    });
    const manifest = await writeWorkDir(openers, workDir, (n) => ctx.log(`${h.slug}: ${n.toLocaleString()} rows…`));
    const warn = identityWarning(h, manifest);
    if (warn) manifest.stats.warnings.unshift(warn);
    await markParsed(ctx.pool, mrfFileId, manifest);
    ctx.log(
      `${h.slug}: parsed ${manifest.stats.items.toLocaleString()} items, ${manifest.stats.rates.toLocaleString()} rates ` +
        `(${manifest.meta.format}, template ${manifest.meta.templateVersion ?? "?"}, updated ${manifest.meta.lastUpdatedOn ?? "?"})`,
    );

    await loadWorkDir(ctx.pool, { hospitalId: h.id, mrfFileId, workDir, log: (m) => ctx.log(`${h.slug}: ${m}`) });
    const summaryRows = await summarizeHospital(ctx.pool, h.id);
    ctx.log(`${h.slug}: ${summaryRows.toLocaleString()} price summary rows`);
    return { status: "loaded", mrfFileId, rows: manifest.stats.rowsRead, summaryRows, warnings: manifest.stats.warnings };
  } catch (err) {
    await markFailed(ctx.pool, mrfFileId, (err as Error).message);
    throw err;
  } finally {
    if (!opts.keepWork) await rm(workDir, { recursive: true, force: true });
  }
}

type StagedPart = MrfPart & { tmp: string | null };

/** Record the version; skip if it's what's already loaded; otherwise store new parts and process. */
async function recordAndProcess(
  ctx: IngestContext,
  h: HospitalIngestTarget,
  staged: StagedPart[],
  opts: { force?: boolean; keepWork?: boolean },
): Promise<IngestOutcome> {
  const parts: MrfPart[] = staged.map(({ tmp: _tmp, ...p }) => p);
  const { row, isNew } = await recordMrfFile(ctx.pool, { hospitalId: h.id, parts });
  if (!isNew && !opts.force && row.status === "loaded" && row.id === h.current_mrf_file_id) {
    await Promise.all(staged.map((p) => p.tmp && rm(p.tmp, { force: true })));
    return { status: "unchanged", reason: "same content as the loaded file" };
  }
  for (const p of staged) {
    if (!p.tmp) continue;
    if (await ctx.storage.exists(p.storageKey)) await rm(p.tmp, { force: true });
    else await ctx.storage.put(p.tmp, p.storageKey);
  }
  const total = parts.reduce((n, p) => n + p.sizeBytes, 0);
  ctx.log(`${h.slug}: ${parts.length} part(s), ${(total / 1024 ** 2).toFixed(1)} MB stored`);
  return processStoredFile(ctx, h, row.id, row.parts.length ? row.parts : parts, opts);
}

export async function ingestHospital(
  ctx: IngestContext,
  h: HospitalIngestTarget,
  opts: { force?: boolean; rediscover?: boolean; keepWork?: boolean } = {},
): Promise<IngestOutcome> {
  let urls = h.mrf_urls_pinned.length ? h.mrf_urls_pinned : opts.rediscover ? [] : h.mrf_urls_discovered;
  if (!urls.length) urls = await discoverHospital(ctx, h);

  // Conditional GETs per part, against whatever version is currently loaded.
  const prev = await latestMrfFile(ctx.pool, h.id);
  const known = new Map(!opts.force && prev?.status === "loaded" ? prev.parts.map((p) => [p.url, p]) : []);

  const staged: StagedPart[] = [];
  const stamp = Date.now();
  try {
    for (const [i, url] of urls.entries()) {
      const before = known.get(url);
      const tmp = path.join(ctx.dataDir, "tmp", `${h.slug}-${stamp}-${i}.part`);
      ctx.log(`${h.slug}: downloading ${urls.length > 1 ? `part ${i + 1}/${urls.length} ` : ""}${url}`);
      const dl = await downloadFile(url, tmp, {
        userAgent: ctx.userAgent,
        maxBytes: ctx.maxBytes,
        etag: before?.etag ?? null,
        lastModified: before?.lastModified ?? null,
      });
      if (dl.status === "not_modified") {
        if (!before) throw new Error(`${url}: got 304 Not Modified without a stored copy`);
        staged.push({ ...before, tmp: null });
      } else if (before && before.sha256 === dl.sha256) {
        await rm(tmp, { force: true });
        staged.push({ ...before, etag: dl.etag, lastModified: dl.lastModified, tmp: null });
      } else {
        const storageKey = storageKeyFor(h, dl.sha256, extensionFor(dl.finalUrl, dl.contentType));
        staged.push({ url, storageKey, sha256: dl.sha256, sizeBytes: dl.sizeBytes, etag: dl.etag, lastModified: dl.lastModified, tmp });
      }
    }
  } catch (err) {
    await Promise.all(staged.map((p) => p.tmp && rm(p.tmp, { force: true })));
    throw err;
  }
  return recordAndProcess(ctx, h, staged, opts);
}

/**
 * Ingest file(s) you already have on disk (e.g. the hospital blocks automated
 * downloads). Pass every part of a multi-part file, in order.
 */
export async function ingestLocalFile(
  ctx: IngestContext,
  h: HospitalIngestTarget,
  files: string[],
  opts: { keepWork?: boolean; force?: boolean; sourceUrl?: string } = {},
): Promise<IngestOutcome> {
  if (!files.length) throw new Error("No files given");
  const staged: StagedPart[] = [];
  for (const file of files) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
    const sha256 = hash.digest("hex");
    const tmp = path.join(ctx.dataDir, "tmp", `${h.slug}-${Date.now()}-${staged.length}.part`);
    await mkdir(path.dirname(tmp), { recursive: true });
    await copyFile(file, tmp);
    staged.push({
      url: opts.sourceUrl ?? `file://${path.basename(file)}`,
      storageKey: storageKeyFor(h, sha256, /\.(csv|json|zip|gz)$/i.exec(file)?.[0]?.toLowerCase() ?? ".bin"),
      sha256,
      sizeBytes: (await stat(file)).size,
      etag: null,
      lastModified: null,
      tmp,
    });
  }
  return recordAndProcess(ctx, h, staged, opts);
}
