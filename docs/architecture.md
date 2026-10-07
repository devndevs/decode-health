# Architecture

## TL;DR

Hospital price files are huge, inconsistent, and change on the hospital's
schedule. So the system is split in two:

- an **offline ingest pipeline** that does all the heavy lifting (streaming
  parse, normalize, bulk load, pre-aggregate), and
- a **read-only website** that only ever touches small, pre-aggregated tables.

```
 hospital website                        ┌──────────── packages/ingest (batch job) ────────────┐
 ├─ cms-hpt.txt ──► discover ──► download ──► parse (stream) ──► work dir ──► load ──► summarize │
 └─ MRF (CSV/JSON, often GBs)    │  raw file kept, SHA-256 addressed          │   COPY + swap   │
                                 └────────────────────────────────────────────┼─────────────────┘
                                                                              ▼
                                                     ┌──────────── Postgres ─────────────┐
   /data (JSON, PR-reviewed) ──► registry:sync ──►   │ reference: regions, hospitals,    │
                                                     │   payers, aliases, services       │
                                                     │ facts (partitioned per hospital): │
                                                     │   charge_items / codes / rates    │
                                                     │ serving: price_summary            │
                                                     └───────────────┬───────────────────┘
                                                                     │ read-only role
                                                     ┌───────────────▼───────────────────┐
                                                     │ apps/web (Next.js)                │
                                                     │  server: price lookups            │
                                                     │  browser: estimator + screener    │◄── plan details and income
                                                     └───────────────────────────────────┘    never leave the browser
```

## Packages

| Package | Responsibility | I/O? |
| --- | --- | --- |
| `@decode-health/core` | Code canonicalization, payer matching, estimator, poverty math, schemas | None — pure functions, runs in browser or server |
| `@decode-health/db` | SQL migrations, registry sync, bulk loader, read queries | Postgres, local files |
| `@decode-health/ingest` | Discovery, safe download, streaming parsers, CLI | Network, disk, Postgres |
| `@decode-health/web` | Pages, accessibility, i18n, security headers | Postgres (read-only) |

Keeping `core` pure is what lets the same estimator run in the browser (so
private inputs stay private) and in tests without any setup.

## Data model

**Reference** (small, from `/data`): `regions` (a tree with a materialized
`path` like `ca/ca-socal/ca-san-diego-county`), `health_systems`, `hospitals`,
`payers`, `payer_aliases`, `payer_products`, `services`, `service_components`.

**File history:** `mrf_files` — one row per distinct version (by SHA-256) of a
hospital's file, with its status, template version, the hospital's own
"last updated" date, and parse stats. The raw bytes stay in object storage.

**Payer/plan spellings:** `raw_payer_plans` — every distinct
`(payer_name, plan_name)` ever seen, stored once and resolved to a canonical
payer + product type (HMO, PPO, Medi-Cal…). Rates point at this table by id,
so fixing an alias re-maps millions of rates without touching them.

**Facts** (big, LIST-partitioned by `hospital_id`):

- `charge_items` — one per item/service (description, setting, billing class,
  gross, cash, de-identified min/max)
- `charge_item_codes` — every code on the item (CPT, HCPCS, MS-DRG, RC, CDM…)
- `charge_rates` — payer-specific rates, including CMS v3.0 allowed-amount
  percentiles, plus a derived `effective_amount` (one comparable dollar figure)

**Serving:** `price_summary` — per hospital × code × setting × billing class:
`n, min, p25, median, p75, max` for cash, gross, all payers, each payer, and
each payer + product type. This is the only fact-derived table the website reads.

## Why partition per hospital

A hospital replaces its whole file at once, so we do too:

1. Build the new version in standalone tables (`charge_items_h12_f345_<load tag>`, …).
2. `COPY` in, build indexes, `ANALYZE` — while nobody reads them.
3. In one short transaction, `DETACH` the old partitions and `ATTACH` the new.
4. `DROP` the old tables.

Readers never see a half-loaded hospital, a failed load leaves the old data
serving, and there's no `DELETE` bloat to vacuum. Dropping a hospital is
instant. Postgres handles hundreds of partitions comfortably; California has
roughly 400 general acute care hospitals.

## Scaling path

| Stage | Hospitals | Approach |
| --- | --- | --- |
| UCSD | 3 | Everything as built; a laptop can run it |
| San Diego County | ~20 | Same; schedule `pnpm ingest run --region ca-san-diego-county` nightly |
| Southern California | ~200 | Run ingest as a container job with more disk; S3/R2 storage adapter; `--concurrency 4+` |
| California | ~400 | Managed Postgres with enough disk for the fact tables (expect hundreds of GB); consider moving facts to Parquet + DuckDB/ClickHouse if ad-hoc analytics grows, keeping `price_summary` in Postgres for the site |

The website's cost doesn't grow with file size: it reads `price_summary` by
`(code_type, code)` and hospital id.

## Key design choices

- **TypeScript everywhere** (one language for a small team), but the pipeline
  is DB-agnostic up to the work-dir CSVs, so a Python/Polars or Rust parser
  could replace the TS one without touching the loader.
- **Plain SQL migrations**, no ORM: partitions, grants, and `COPY` are explicit.
- **Ranges, not single prices**, everywhere a person sees a number.
- **Region tree**, not hard-coded counties, so "San Diego", "SoCal", and
  "California" are just nodes; going statewide is mostly adding data.
