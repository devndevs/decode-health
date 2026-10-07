import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalStorage, S3Storage, storageFromEnv } from "./storage";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "storage-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("LocalStorage", () => {
  it("moves files in and refuses keys that escape the root", async () => {
    const s = new LocalStorage(path.join(dir, "local"));
    const src = path.join(dir, "a.json");
    await writeFile(src, "{}");
    await s.put(src, "raw/ca/x/a.json");
    expect(await s.exists("raw/ca/x/a.json")).toBe(true);
    expect(await readFile(await s.get("raw/ca/x/a.json"), "utf8")).toBe("{}");
    await expect(s.put(src, "../../etc/passwd")).rejects.toThrow(/escapes/);
  });
});

describe("storageFromEnv", () => {
  it("defaults to local disk and validates s3 settings", () => {
    expect(storageFromEnv(dir, {})).toBeInstanceOf(LocalStorage);
    expect(() => storageFromEnv(dir, { STORAGE_BACKEND: "s3", S3_BUCKET: "b" })).toThrow(/S3_ACCESS_KEY_ID/);
    expect(storageFromEnv(dir, { STORAGE_BACKEND: "s3", S3_BUCKET: "b", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s" })).toBeInstanceOf(S3Storage);
  });
});

/**
 * Runs against any S3-compatible endpoint, e.g. `moto_server -p 5055` or MinIO:
 *   TEST_S3_ENDPOINT=http://127.0.0.1:5055 pnpm test
 */
const ENDPOINT = process.env.TEST_S3_ENDPOINT;
describe.skipIf(!ENDPOINT)("S3Storage", () => {
  const creds = { accessKeyId: "test", secretAccessKey: "test" };
  const bucket = `decode-test-${process.pid}`;

  beforeAll(async () => {
    const c = new S3Client({ region: "us-east-1", endpoint: ENDPOINT, forcePathStyle: true, credentials: creds });
    await c.send(new CreateBucketCommand({ Bucket: bucket }));
  });

  it("uploads in parts, reports existence, and downloads through the cache", async () => {
    const s = new S3Storage({ bucket, endpoint: ENDPOINT, region: "us-east-1", ...creds, prefix: "t/", cacheDir: path.join(dir, "cache"), partSize: 5 * 1024 ** 2 });
    const body = randomBytes(11 * 1024 ** 2); // forces a 3-part multipart upload
    const src = path.join(dir, "big.json");
    await writeFile(src, body);

    expect(await s.exists("raw/ca/h/big.json")).toBe(false);
    await s.put(src, "raw/ca/h/big.json");
    await expect(stat(src)).rejects.toThrow(); // local copy removed after upload
    expect(await s.exists("raw/ca/h/big.json")).toBe(true);

    const local = await s.get("raw/ca/h/big.json");
    expect((await readFile(local)).equals(body)).toBe(true);
    expect(await s.get("raw/ca/h/big.json")).toBe(local); // cache hit
    await expect(s.get("raw/missing.json")).rejects.toThrow(/Not in storage/);
    await expect(s.put(src, "../escape.json")).rejects.toThrow(/Unsafe/);
  });
});
