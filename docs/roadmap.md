# Roadmap

## Phase 1 — UC San Diego Health (now)

- [ ] Verify the three UCSD registry entries (identifiers, cms-hpt.txt location names)
- [ ] Load UCSD's real file; map every unmatched payer spelling
- [ ] Spot-check estimates against UCSD's own patient estimator
- [ ] Verify every help program entry against official sources
- [ ] Deploy (website + managed Postgres + scheduled ingest job)

## Phase 2 — San Diego County

- [ ] Add hospitals from `data/registry/hospitals/ca/san-diego-county/_BACKLOG.md`
- [ ] Add local resources (county programs, community clinics)
- [ ] Nightly refresh + freshness alerts

## Phase 3 — Southern California

- [ ] Activate counties in `regions.json`; add regional Medi-Cal plans (L.A. Care, CalOptima, IEHP, …)
- [ ] S3/R2 storage adapter; ingest as a container job
- [ ] Region picker on the help page

## Phase 4 — California

- [ ] Remaining counties; capacity review of the fact tables

## Feature backlog

- **Plan presets:** Covered California's standardized benefit designs (same
  deductible and copays for every plan in a metal tier) so people can pick
  "Silver 87" instead of typing numbers
- **Doctor pricing outside hospitals:** insurer Transparency-in-Coverage files
  (very large; separate pipeline)
- **More services** in the catalog, and a "look up any billing code" page
- **Distance sorting** using hospital coordinates
- **More languages** (Vietnamese, Tagalog, Chinese, Arabic, Korean are common in San Diego)
- **Printable summary** to bring to a billing office, including the Good Faith Estimate request
