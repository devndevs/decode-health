# Data pipeline

## TL;DR

`pnpm ingest run --hospital <slug>` does: **discover → download → parse →
load → summarize**. Each step is idempotent, unchanged files are skipped, and a
failure leaves the previous data serving.

## 1. Discover

Since 2024 every hospital must publish `cms-hpt.txt` at the root of its
website. Each block lists a `location-name`, `source-page-url`, and `mrf-url`.
We pick the block whose `location-name` contains one of the hospital's
`locationNameMatch` terms (see `data/registry/hospitals/...`).

If a hospital's txt file is missing or wrong, pin the URL with
`priceTransparency.mrfUrl` in its registry file.

## 2. Download (`packages/ingest/src/fetch.ts`)

- HTTPS only; hostnames must resolve to public IPs; redirects re-validated.
- Conditional GET (ETag / Last-Modified) and SHA-256 dedupe: an unchanged file
  costs one request.
- Hard size cap (`INGEST_MAX_FILE_BYTES`, default 20 GB) and a stall timeout.
- Raw files are stored immutably as
  `raw/<region path>/<hospital>/<date>_<sha12>.<ext>`.

Some hospitals block automated downloads. Download in a browser and run
`pnpm ingest load-file --hospital <slug> --file <path>`.

## 3. Parse (`packages/ingest/src/parsers/`)

Supports every layout the CMS template allows, streaming in constant memory:

| Layout | Notes |
| --- | --- |
| CSV "tall" | One row per item × payer/plan. Rows are de-duplicated back into items. |
| CSV "wide" | Payer and plan live in column headers: `standard_charge\|Aetna\|PPO\|negotiated_dollar` |
| JSON | `standard_charge_information` is streamed element by element |

Also handled: gzip and zip archives (largest `.csv`/`.json` entry), UTF-16
files from Excel, template v2.x (`hospital_location`, `estimated_amount`) and
v3.0 (`location_name`, `median_amount`, `10th_percentile`, `90th_percentile`,
`count`), and the usual spec violations (`$1,234.00`, `N/A`, CPT codes
labelled HCPCS, revenue codes without leading zeros).

Check the current spec at
<https://github.com/CMSgov/hospital-price-transparency> when CMS publishes a
new template version; new column names go in the maps at the top of
`parsers/csv.ts` and `parsers/json.ts`, with a fixture and a test.

### The work-dir contract

The parser writes, with no database access:

```
items.csv         item_id, description, setting, billing_class, modifiers, …
codes.csv         item_id, code_type, code
rates.csv         payer_plan_id (local), item_id, negotiated_*, *_allowed, effective_amount, …
payer_plans.json  [[local_id, payer_name, plan_name], …]
meta.json         file metadata + stats + warnings
```

Columns are defined once in `packages/db/src/work-files.ts`. `pnpm ingest
validate <file>` produces exactly this, so you can inspect any file offline.

### Effective amount

Hospitals express prices as dollars, percentages of charges, algorithms, or
(v3.0) historical allowed-amount percentiles. We derive one comparable figure:

1. negotiated dollar amount
2. median allowed amount (v3.0)
3. estimated amount (v2.x)
4. percentage × gross charge, when the methodology is "percent of total billed charges"

Rates with none of these are kept but excluded from summaries
(`ratesWithoutAmount` in the stats).

## 4. Load (`packages/db/src/load.ts`)

Resolve payer spellings → `COPY` into staging tables → index → `ANALYZE` →
swap partitions in one short transaction → drop old partitions. See
[architecture.md](architecture.md#why-partition-per-hospital).

## 5. Summarize

Rebuilds `price_summary` for the hospital. Re-run for everyone after changing
payer aliases: `pnpm ingest payers:rematch && pnpm ingest summarize --all`.

## Keeping payers matched

After loading a new hospital:

```bash
pnpm ingest payers:unmatched
```

Add recognized spellings to `aliases` in `data/payers/payers.json`, then
`pnpm ingest registry:sync` (which re-matches) and `pnpm ingest summarize --all`.

## Scheduling

Hospitals must update files at least annually; many update monthly. Suggested:

- Nightly: `pnpm ingest run --region ca-san-diego-county` (cheap when nothing changed)
- Weekly: `pnpm ingest run --region <slug> --rediscover` to pick up URL changes
- Alert when `pnpm ingest status` shows a file older than 12 months or a `failed` status

Run ingest as a separate container/job from the website, with its own
database role and memory limits (see [security-and-privacy.md](security-and-privacy.md)).

## Production storage

`LocalStorage` is for development. Implement `RawStorage`
(`packages/ingest/src/storage.ts`) for S3, R2, or GCS — `put` should use
multipart upload, `get` should stream to a temp file — and add a lifecycle rule
keeping the last few versions per hospital.

## Proxies

Node's built-in `fetch` ignores `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1`
is set (Node 22.21+).
