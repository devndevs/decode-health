#!/usr/bin/env node
/**
 * Fails if the repository tracks a file that looks like hospital price data or
 * is simply too big for git. Price files belong in object storage (R2/S3) or
 * the git-ignored .data/ folder — see docs/database.md.
 *
 *   node scripts/check-no-data-files.mjs        (runs in CI)
 */
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";

const MAX_BYTES = 2 * 1024 * 1024;
// Names CMS recommends for machine-readable files, plus what hospitals actually use.
const PRICE_FILE = /(standard[-_ ]?charges|chargemaster|cms-hpt\.txt$|_mrf\.|machine[-_ ]?readable)/i;
// Small synthetic fixtures used by tests are fine.
const ALLOWED = /^packages\/ingest\/src\/fixtures\//;

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const problems = [];
for (const f of files) {
  let size = 0;
  try {
    size = statSync(f).size;
  } catch {
    continue; // deleted in the working tree
  }
  if (size > MAX_BYTES) problems.push(`${f} is ${(size / 1024 ** 2).toFixed(1)} MB (limit ${MAX_BYTES / 1024 ** 2} MB)`);
  else if (PRICE_FILE.test(f) && !ALLOWED.test(f)) problems.push(`${f} looks like a hospital price file`);
}

if (problems.length) {
  console.error("Data files don't belong in git. Move them to .data/ (ignored) or object storage:\n  - " + problems.join("\n  - "));
  process.exit(1);
}
console.log(`OK: ${files.length} tracked files, none over ${MAX_BYTES / 1024 ** 2} MB or named like price data.`);
