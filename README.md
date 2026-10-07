# Decode Health

Know the ballpark cost of care **before** you go — so a surprise bill doesn't
become one more thing to worry about.

Decode Health turns the giant price files that hospitals are legally required
to publish into a simple range: the cash price, what insurers typically pay,
and an estimate of what *you* would owe with your plan. It also points people
who are uninsured or low-income to the coverage, discounts, and rights they
may not know they have.

**Status:** scaffold. Starting with UC San Diego Health → all of San Diego
County → Southern California → California.

## Quick start

Requires Node 22+, pnpm 10+, and Docker (or any Postgres 16+).

```bash
pnpm install
cp .env.example .env
pnpm db:up                         # local Postgres in Docker
pnpm ingest registry:sync          # migrate + load hospitals, payers, services from /data
pnpm ingest run --hospital ucsd-hillcrest   # discover, download, parse, load UCSD's real file
pnpm dev                           # http://localhost:3000
```

No network access to the hospital, or just want to click around? Load the
synthetic fixture as a clearly fake "Sample Hospital":

```bash
pnpm ingest demo:seed
```

## How the repo is organized

```
apps/web/            Next.js site (React). Read-only DB access, strict CSP, English + Spanish.
packages/core/       Pure domain logic, no I/O: code normalization, payer matching,
                     the cost estimator, poverty-level math, data schemas.
packages/db/         Postgres schema (plain SQL migrations), bulk loader, read queries.
packages/ingest/     CLI: discover → download → parse → load → summarize hospital files.
data/                Hand-curated reference data, reviewed in pull requests:
  registry/            regions, health systems, one JSON file per hospital
  payers/              insurers + every spelling hospitals use for them
  services/            plain-language service catalog mapped to billing codes
  resources/           financial-help programs and patient rights
  reference/           federal poverty guidelines
docs/                Architecture, pipeline, how to add a hospital, security.
```

The rule of thumb: **anything a non-developer might need to update is data in
`/data`, not code.** Adding a hospital, an insurer alias, or a help program is a
JSON edit that `pnpm ingest registry:check` validates.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` / `pnpm build` | Run or build the website |
| `pnpm test` | Unit tests; set `TEST_DATABASE_URL` to also run the end-to-end DB test |
| `pnpm typecheck` | Type-check every package |
| `pnpm db:migrate` | Apply SQL migrations |
| `pnpm ingest registry:check` | Validate `/data` (no database needed) |
| `pnpm ingest registry:sync` | Migrate, then upsert `/data` into Postgres |
| `pnpm ingest run --region ca-san-diego-county` | Refresh every hospital in a region |
| `pnpm ingest validate <file>` | Parse a hospital file offline and print a report |
| `pnpm ingest load-file --hospital <slug> --file <path>` | Ingest a file you downloaded by hand |
| `pnpm ingest payers:unmatched` | Insurer spellings that still need an alias |
| `pnpm ingest status` | What's loaded and how fresh it is |

## Docs

- [Architecture](docs/architecture.md) — data model, why tables are partitioned per hospital, how it scales
- [Data pipeline](docs/data-pipeline.md) — file formats, the parse/load contract, scheduling refreshes
- [Adding a hospital](docs/adding-a-hospital.md) — and expanding to a new county
- [Security & privacy](docs/security-and-privacy.md) — what we collect (almost nothing) and how we protect it
- [Roadmap](docs/roadmap.md)

## Important caveats

- Estimates are not quotes. Hospital files don't include every doctor or
  anesthesia bill, and the final bill depends on the care actually given.
- Registry entries and help-program content are marked **unverified** until a
  person checks them against official sources. Do that before launch.
- CPT® codes are AMA-copyrighted; service descriptions here are our own.
