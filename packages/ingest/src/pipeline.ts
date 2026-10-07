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
  setDiscoveredUrl,
  type HospitalIngestTarget,
  type Pool,
  type WorkDirManifest,
} from "@decode-health/db";
import { loadWorkDir, summarizeHospital } from "@decode-health/db/load";
import { parseCmsHptTxt, selectEntry } from "./discover";
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

export async function discoverHospital(ctx: IngestContext, h: HospitalIngestTarget): Promise<string> {
  if (!h.cms_hpt_txt_url) throw new Error(`${h.slug}: no cmsHptTxtUrl in the registry and no pinned mrfUrl`);
  const entries = parseCmsHptTxt(await fetchText(h.cms_hpt_txt_url, { userAgent: ctx.userAgent }));
  const entry = selectEntry(entries, h.location_name_match);
  await setDiscoveredUrl(ctx.pool, h.id, entry.mrfUrl, entry.sourcePageUrl);
  ctx.log(`${h.slug}: discovered ${entry.mrfUrl} ("${entry.locationName}")`);
  return entry.mrfUrl;
}

function extensionFor(url: string, contentType: string | null): string {
  const fromPath = /\.(csv|json|zip|gz)$/i.exec(new URL(url).pathname)?.[0]?.toLowerCase();
  if (fromPath) return fromPath;
  if (contentType?.includes("json")) return ".json";
  if (contentType?.includes("zip")) return ".zip";
  if (contentType?.includes("csv")) return ".csv";
  return ".bin";
}

/** Warn when the file's own hospital name doesn't mention any of our match terms (wrong file?). */
function identityWarning(h: HospitalIngestTarget, m: WorkDirManifest): string | null {
  if (!h.location_name_match.length) return null;
  const haystack = [m.meta.hospitalName ?? "", ...m.meta.locationNames].join(" | ").toLowerCase();
  const ok = h.location_name_match.some((t) => haystack.includes(t.toLowerCase()));
  return ok ? null : `File names "${haystack}" — none of ${JSON.stringify(h.location_name_match)}. Check this is the right file.`;
}

/** Parse a stored raw file, load it, and summarize. Shared by network and local-file ingest. */
export async function processStoredFile(
  ctx: IngestContext,
  h: HospitalIngestTarget,
  mrfFileId: number,
  storageKey: string,
  opts: { keepWork?: boolean } = {},
): Promise<Extract<IngestOutcome, { status: "loaded" }>> {
  const workDir = path.join(ctx.dataDir, "work", h.slug, String(mrfFileId));
  try {
    const local = await ctx.storage.get(storageKey);
    ctx.log(`${h.slug}: parsing ${path.basename(local)}`);
    const parsed = await parseMrfFile(local, { maxUncompressedBytes: ctx.maxUncompressedBytes });
    const manifest = await writeWorkDir(parsed, workDir, (n) => ctx.log(`${h.slug}: ${n.toLocaleString()} rows…`));
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

export async function ingestHospital(
  ctx: IngestContext,
  h: HospitalIngestTarget,
  opts: { force?: boolean; rediscover?: boolean; keepWork?: boolean } = {},
): Promise<IngestOutcome> {
  let url = h.mrf_url_pinned ?? (opts.rediscover ? null : h.mrf_url_discovered);
  if (!url) url = await discoverHospital(ctx, h);

  const prev = await latestMrfFile(ctx.pool, h.id);
  const conditional = !opts.force && prev?.status === "loaded" && prev.source_url === url;
  const tmp = path.join(ctx.dataDir, "tmp", `${h.slug}-${Date.now()}.part`);

  ctx.log(`${h.slug}: downloading ${url}`);
  const dl = await downloadFile(url, tmp, {
    userAgent: ctx.userAgent,
    maxBytes: ctx.maxBytes,
    etag: conditional ? prev.etag : null,
    lastModified: conditional ? prev.last_modified : null,
  });
  if (dl.status === "not_modified") return { status: "unchanged", reason: "server returned 304 Not Modified" };

  const date = new Date().toISOString().slice(0, 10);
  const storageKey = `raw/${h.region_path}/${h.slug}/${date}_${dl.sha256.slice(0, 12)}${extensionFor(dl.finalUrl, dl.contentType)}`;
  const { row, isNew } = await recordMrfFile(ctx.pool, {
    hospitalId: h.id,
    sourceUrl: url,
    storageKey,
    sha256: dl.sha256,
    sizeBytes: dl.sizeBytes,
    etag: dl.etag,
    lastModified: dl.lastModified,
  });

  if (!isNew) {
    await rm(tmp, { force: true });
    if ((row.status === "loaded" || row.status === "superseded") && !opts.force && row.id === h.current_mrf_file_id) {
      return { status: "unchanged", reason: "same SHA-256 as the loaded file" };
    }
  } else {
    await ctx.storage.put(tmp, storageKey);
    ctx.log(`${h.slug}: stored ${(dl.sizeBytes / 1024 ** 2).toFixed(1)} MB as ${storageKey}`);
  }
  return processStoredFile(ctx, h, row.id, row.storage_key, opts);
}

/** Ingest a file you already have on disk (e.g. the hospital blocks automated downloads). */
export async function ingestLocalFile(
  ctx: IngestContext,
  h: HospitalIngestTarget,
  file: string,
  opts: { keepWork?: boolean; sourceUrl?: string } = {},
): Promise<IngestOutcome> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  const sha256 = hash.digest("hex");
  const { size } = await stat(file);

  const date = new Date().toISOString().slice(0, 10);
  const ext = /\.(csv|json|zip|gz)$/i.exec(file)?.[0]?.toLowerCase() ?? ".bin";
  const storageKey = `raw/${h.region_path}/${h.slug}/${date}_${sha256.slice(0, 12)}${ext}`;
  const { row, isNew } = await recordMrfFile(ctx.pool, {
    hospitalId: h.id,
    sourceUrl: opts.sourceUrl ?? `file://${path.basename(file)}`,
    storageKey,
    sha256,
    sizeBytes: size,
    etag: null,
    lastModified: null,
  });
  if (isNew) {
    const tmp = path.join(ctx.dataDir, "tmp", `${h.slug}-${Date.now()}.part`);
    await mkdir(path.dirname(tmp), { recursive: true });
    await copyFile(file, tmp);
    await ctx.storage.put(tmp, storageKey);
  }
  return processStoredFile(ctx, h, row.id, row.storage_key, opts);
}
