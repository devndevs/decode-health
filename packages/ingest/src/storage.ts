/**
 * Where raw hospital files live. Raw files are immutable and content-addressed
 * by SHA-256, so we can always re-parse a historical version or audit what a
 * hospital published on a given date.
 *
 * LocalStorage is for development. For production, implement RawStorage
 * against S3 / R2 / GCS (multipart upload in put(), download-to-temp in get())
 * and keep a lifecycle rule that retains the last N versions per hospital.
 */
import { copyFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";

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
