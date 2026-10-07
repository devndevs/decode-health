/**
 * Where raw hospital files live. Raw files are immutable and content-addressed
 * by SHA-256, so we can always re-parse a historical version or audit what a
 * hospital published on a given date. They never go in git.
 *
 *   LocalStorage  development: files under DATA_DIR (git-ignored .data/)
 *   S3Storage     production: Cloudflare R2, AWS S3, MinIO — anything S3-compatible
 *
 * Pick with STORAGE_BACKEND=local|s3 (see storageFromEnv and .env.example).
 */
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { GetObjectCommand, HeadObjectCommand, S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

export interface RawStorage {
  /** Move/upload a local file to `key`. The local file may be removed. */
  put(localFile: string, key: string): Promise<void>;
  /** Return a local path to read `key` from (downloading first if remote). */
  get(key: string): Promise<string>;
  exists(key: string): Promise<boolean>;
}

export class LocalStorage implements RawStorage {
  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    const p = path.resolve(this.root, key);
    if (!p.startsWith(path.resolve(this.root) + path.sep)) throw new Error(`Storage key escapes root: ${key}`);
    return p;
  }

  async put(localFile: string, key: string) {
    const dest = this.resolve(key);
    await mkdir(path.dirname(dest), { recursive: true });
    try {
      await rename(localFile, dest);
    } catch {
      await copyFile(localFile, dest);
    }
  }

  async get(key: string) {
    return this.resolve(key);
  }

  async exists(key: string) {
    return stat(this.resolve(key)).then(
      () => true,
      () => false,
    );
  }
}

export interface S3StorageOptions {
  bucket: string;
  /** R2: https://<ACCOUNT_ID>.r2.cloudflarestorage.com. Omit for AWS S3. */
  endpoint?: string;
  /** R2 uses "auto". */
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Optional key prefix, e.g. "prod/". */
  prefix?: string;
  /** Downloads are cached here so a re-parse doesn't re-download gigabytes. */
  cacheDir: string;
  /** Multipart part size in bytes (min 5 MiB). */
  partSize?: number;
}

const CONTENT_TYPES: Record<string, string> = {
  ".json": "application/json",
  ".csv": "text/csv",
  ".zip": "application/zip",
  ".gz": "application/gzip",
};

export class S3Storage implements RawStorage {
  private readonly client: S3Client;

  constructor(private readonly opts: S3StorageOptions) {
    const config: S3ClientConfig = {
      region: opts.region ?? "auto",
      endpoint: opts.endpoint,
      forcePathStyle: Boolean(opts.endpoint),
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
      // Only send/verify checksums when an operation requires them; some S3-compatible
      // stores (including older R2 behavior) reject the SDK's newer default checksums.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    };
    this.client = new S3Client(config);
  }

  private objectKey(key: string): string {
    if (key.includes("..") || key.startsWith("/")) throw new Error(`Unsafe storage key: ${key}`);
    return `${this.opts.prefix ?? ""}${key}`;
  }

  /** Streams the file up in parts (hospital files are often 100 MB to 10+ GB), then removes the local copy. */
  async put(localFile: string, key: string) {
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.opts.bucket,
        Key: this.objectKey(key),
        Body: createReadStream(localFile),
        ContentType: CONTENT_TYPES[path.extname(key).toLowerCase()] ?? "application/octet-stream",
      },
      partSize: Math.max(5 * 1024 ** 2, this.opts.partSize ?? 64 * 1024 ** 2),
      queueSize: 4,
    });
    await upload.done();
    await rm(localFile, { force: true });
  }

  async get(key: string) {
    const cached = path.resolve(this.opts.cacheDir, key);
    if (!cached.startsWith(path.resolve(this.opts.cacheDir) + path.sep)) throw new Error(`Storage key escapes cache: ${key}`);
    const remoteSize = await this.size(key);
    if (remoteSize == null) throw new Error(`Not in storage: ${key}`);
    const local = await stat(cached).catch(() => null);
    if (local?.size === remoteSize) return cached;

    await mkdir(path.dirname(cached), { recursive: true });
    const tmp = `${cached}.download`;
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.opts.bucket, Key: this.objectKey(key) }));
    if (!res.Body) throw new Error(`Empty body for ${key}`);
    await pipeline(res.Body as Readable, createWriteStream(tmp));
    await rename(tmp, cached);
    return cached;
  }

  async exists(key: string) {
    return (await this.size(key)) != null;
  }

  private async size(key: string): Promise<number | null> {
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.opts.bucket, Key: this.objectKey(key) }));
      return head.ContentLength ?? 0;
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) return null;
      throw err;
    }
  }
}

/** STORAGE_BACKEND=s3 uses S3_* variables; anything else uses local disk under dataDir. */
export function storageFromEnv(dataDir: string, env: NodeJS.ProcessEnv = process.env): RawStorage {
  if ((env.STORAGE_BACKEND ?? "local") !== "s3") return new LocalStorage(dataDir);
  const required = ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const;
  const missing = required.filter((k) => !env[k]);
  if (missing.length) throw new Error(`STORAGE_BACKEND=s3 needs ${missing.join(", ")}`);
  return new S3Storage({
    bucket: env.S3_BUCKET!,
    endpoint: env.S3_ENDPOINT || undefined,
    region: env.S3_REGION || "auto",
    accessKeyId: env.S3_ACCESS_KEY_ID!,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
    prefix: env.S3_PREFIX || undefined,
    cacheDir: path.join(dataDir, "cache"),
  });
}
