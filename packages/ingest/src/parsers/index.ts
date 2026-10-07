/**
 * Open any hospital price file — CSV or JSON, plain, gzipped, or zipped, UTF-8
 * or UTF-16 — and hand back a streaming ParseResult.
 */
import { open as openFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { Transform, type Readable, type TransformCallback } from "node:stream";
import { createGunzip } from "node:zlib";
import yauzl from "yauzl";
import { parseCsv } from "./csv";
import { parseJson } from "./json";
import type { ParseResult } from "./types";

export type { ParseResult, ParsedRecord } from "./types";

export interface OpenOptions {
  /** Abort if the decompressed stream exceeds this many bytes (zip/gzip bomb guard). */
  maxUncompressedBytes?: number;
}

const DEFAULT_MAX_UNCOMPRESSED = 100 * 1024 ** 3;

async function head(file: string, n: number): Promise<Buffer> {
  const fh = await openFile(file, "r");
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

class ByteLimit extends Transform {
  private seen = 0;
  constructor(private readonly limit: number) {
    super();
  }
  override _transform(chunk: Buffer, _e: BufferEncoding, cb: TransformCallback) {
    this.seen += chunk.length;
    if (this.seen > this.limit) cb(new Error(`Decompressed data exceeds ${this.limit} bytes`));
    else cb(null, chunk);
  }
}

/** Re-encode UTF-16LE (BOM FF FE) to UTF-8. Some hospital CSV exports from Excel are UTF-16. */
class Utf16ToUtf8 extends Transform {
  private decoder = new StringDecoder("utf16le");
  private first = true;
  override _transform(chunk: Buffer, _e: BufferEncoding, cb: TransformCallback) {
    let s = this.decoder.write(chunk);
    if (this.first) {
      s = s.replace(/^﻿/, "");
      this.first = false;
    }
    cb(null, Buffer.from(s, "utf8"));
  }
  override _flush(cb: TransformCallback) {
    cb(null, Buffer.from(this.decoder.end(), "utf8"));
  }
}

function openZipEntry(file: string, limit: number): Promise<{ stream: Readable; name: string }> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, validateEntrySizes: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error("Could not open zip"));
      let bestEntry: yauzl.Entry | null = null;
      zip.on("entry", (entry: yauzl.Entry) => {
        const isData = /\.(csv|json)$/i.test(entry.fileName) && !entry.fileName.startsWith("__MACOSX/");
        if (isData && (!bestEntry || entry.uncompressedSize > bestEntry.uncompressedSize)) bestEntry = entry;
        zip.readEntry();
      });
      zip.on("end", () => {
        const entry = bestEntry as yauzl.Entry | null;
        if (!entry) return reject(new Error("Zip contains no .csv or .json file"));
        if (entry.uncompressedSize > limit) return reject(new Error(`Zip entry ${entry.fileName} is larger than ${limit} bytes`));
        zip.openReadStream(entry, (e2, stream) => {
          if (e2 || !stream) return reject(e2 ?? new Error("Could not read zip entry"));
          resolve({ stream, name: entry.fileName });
        });
      });
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}

/** Returns a fresh decompressed byte stream each call (we open twice: once to sniff, once to parse). */
async function openDecompressed(file: string, limit: number): Promise<Readable> {
  const magic = await head(file, 4);
  if (magic[0] === 0x50 && magic[1] === 0x4b && magic[2] === 0x03 && magic[3] === 0x04) {
    return (await openZipEntry(file, limit)).stream.pipe(new ByteLimit(limit));
  }
  if (magic[0] === 0x1f && magic[1] === 0x8b) {
    return createReadStream(file).pipe(createGunzip()).pipe(new ByteLimit(limit));
  }
  return createReadStream(file).pipe(new ByteLimit(limit));
}

async function sniff(stream: Readable): Promise<Buffer> {
  for await (const chunk of stream) {
    stream.destroy();
    return chunk as Buffer;
  }
  return Buffer.alloc(0);
}

export async function parseMrfFile(file: string, opts: OpenOptions = {}): Promise<ParseResult> {
  const limit = opts.maxUncompressedBytes ?? DEFAULT_MAX_UNCOMPRESSED;
  const first = await sniff(await openDecompressed(file, limit));
  const utf16 = first[0] === 0xff && first[1] === 0xfe;
  const text = utf16 ? Buffer.from(first.toString("utf16le"), "utf8") : first;
  const firstChar = text.toString("utf8", 0, Math.min(text.length, 1024)).replace(/^﻿/, "").trimStart()[0];

  let stream = await openDecompressed(file, limit);
  if (utf16) stream = stream.pipe(new Utf16ToUtf8());
  return firstChar === "{" ? parseJson(stream) : parseCsv(stream);
}
