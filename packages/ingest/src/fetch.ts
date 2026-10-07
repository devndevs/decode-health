/**
 * Hardened downloader for hospital files.
 *
 * URLs come from hospital websites (cms-hpt.txt), so treat them as untrusted:
 *   - https only, no embedded credentials
 *   - hostnames must resolve to public addresses (no SSRF into our network)
 *   - redirects followed manually, each hop re-validated
 *   - hard byte cap, stall timeout, SHA-256 computed while streaming
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import path from "node:path";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface FetchOptions {
  userAgent: string;
  maxBytes: number;
  /** Abort if no bytes arrive for this long. */
  stallTimeoutMs?: number;
  etag?: string | null;
  lastModified?: string | null;
}

export type DownloadResult =
  | { status: "not_modified" }
  | {
      status: "ok";
      file: string;
      sha256: string;
      sizeBytes: number;
      etag: string | null;
      lastModified: string | null;
      contentType: string | null;
      finalUrl: string;
    };

function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === "::" || v === "::1") return true;
    if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
    return /^(fc|fd|fe8|fe9|fea|feb)/.test(v);
  }
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

export async function assertSafeUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error(`Refusing non-https URL: ${raw}`);
  if (url.username || url.password) throw new Error("Refusing URL with embedded credentials");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new Error(`Refusing internal host: ${host}`);
  }
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  for (const { address } of addrs) {
    if (isPrivateAddress(address)) throw new Error(`Refusing ${host}: resolves to private address ${address}`);
  }
  return url;
}

async function safeFetch(raw: string, headers: Record<string, string>, signal: AbortSignal): Promise<{ res: Response; url: string }> {
  let current = raw;
  for (let hop = 0; hop <= 5; hop++) {
    await assertSafeUrl(current);
    let res: Response;
    try {
      res = await fetch(current, { headers, redirect: "manual", signal });
    } catch (err) {
      // undici reports "fetch failed" and hides the real reason (DNS, TLS, refused, proxy) in `cause`.
      const cause = (err as { cause?: { message?: string; code?: string } }).cause;
      throw new Error(`GET ${current} failed: ${cause?.code ?? ""} ${cause?.message ?? (err as Error).message}`.replace(/\s+/g, " "));
    }
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      const loc = res.headers.get("location");
      await res.body?.cancel();
      if (!loc) throw new Error(`Redirect without Location from ${current}`);
      current = new URL(loc, current).toString();
      continue;
    }
    return { res, url: current };
  }
  throw new Error(`Too many redirects starting at ${raw}`);
}

class Meter extends Transform {
  bytes = 0;
  readonly hash = createHash("sha256");
  constructor(
    private readonly maxBytes: number,
    private readonly onChunk: () => void,
  ) {
    super();
  }
  override _transform(chunk: Buffer, _e: BufferEncoding, cb: TransformCallback) {
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes) return cb(new Error(`File exceeds limit of ${this.maxBytes} bytes`));
    this.hash.update(chunk);
    this.onChunk();
    cb(null, chunk);
  }
}

export async function downloadFile(url: string, dest: string, opts: FetchOptions): Promise<DownloadResult> {
  const controller = new AbortController();
  const stallMs = opts.stallTimeoutMs ?? 120_000;
  let timer = setTimeout(() => controller.abort(new Error("Download stalled")), stallMs);
  const poke = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error("Download stalled")), stallMs);
  };

  const headers: Record<string, string> = { "user-agent": opts.userAgent, accept: "*/*" };
  if (opts.etag) headers["if-none-match"] = opts.etag;
  if (opts.lastModified) headers["if-modified-since"] = opts.lastModified;

  try {
    const { res, url: finalUrl } = await safeFetch(url, headers, controller.signal);
    if (res.status === 304) return { status: "not_modified" };
    if (!res.ok || !res.body) throw new Error(`GET ${finalUrl} → HTTP ${res.status}`);
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > opts.maxBytes) throw new Error(`File is ${declared} bytes, over the ${opts.maxBytes} byte limit`);

    await mkdir(path.dirname(dest), { recursive: true });
    const meter = new Meter(opts.maxBytes, poke);
    await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), meter, createWriteStream(dest));
    return {
      status: "ok",
      file: dest,
      sha256: meter.hash.digest("hex"),
      sizeBytes: meter.bytes,
      etag: res.headers.get("etag"),
      lastModified: res.headers.get("last-modified"),
      contentType: res.headers.get("content-type"),
      finalUrl,
    };
  } catch (err) {
    await rm(dest, { force: true });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Small text fetch (cms-hpt.txt). */
export async function fetchText(url: string, opts: { userAgent: string; maxBytes?: number }): Promise<string> {
  const signal = AbortSignal.timeout(30_000);
  const { res, url: finalUrl } = await safeFetch(url, { "user-agent": opts.userAgent, accept: "text/plain,*/*" }, signal);
  if (!res.ok) throw new Error(`GET ${finalUrl} → HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > (opts.maxBytes ?? 1024 * 1024)) throw new Error(`${finalUrl} is unexpectedly large`);
  return buf.toString("utf8");
}

export { isPrivateAddress };
