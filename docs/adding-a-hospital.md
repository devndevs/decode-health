# Adding a hospital

## TL;DR

1. **Copy** `data/registry/hospitals/_TEMPLATE.json` to
   `data/registry/hospitals/<state>/<county>/<slug>.json`.
2. **Fill in** name, address, website, and `cmsHptTxtUrl` (`https://<site>/cms-hpt.txt`).
3. **Run** `pnpm ingest registry:check`, then `registry:sync`, then
   `pnpm ingest run --hospital <slug>`.
4. **Fix payer spellings** with `pnpm ingest payers:unmatched`.
5. **Verify** the checklist below, then set `"verified": true`.

## Details

### File location and naming

The directory mirrors the region tree: a hospital with
`"region": "ca-orange-county"` lives in `hospitals/ca/orange-county/`, and the
filename must equal its `slug`. `registry:check` enforces both.

Slugs are permanent (they're in URLs). Use `<system>-<campus>`, e.g.
`sharp-memorial`, `scripps-la-jolla`.

### Finding the file

Open `https://<hospital-site>/cms-hpt.txt`. Find the block for this location
and put a distinctive part of its `location-name` in `locationNameMatch`. If
several locations share one file (one license, multiple campuses), it's fine
for multiple registry entries to match the same `mrf-url`.

If the txt file is missing or broken, set `priceTransparency.mrfUrl` to the
file URL from the hospital's price transparency page.

### Verification checklist

Before `"verified": true`:

- [ ] Name and address match the hospital's own site
- [ ] CMS Certification Number (CCN) and type 2 NPI(s) filled in (the file's
      `type_2_npi` field and the NPPES registry help)
- [ ] HCAI facility ID filled in (California)
- [ ] `financialAssistanceUrl` points to the hospital's financial assistance / charity care policy
- [ ] `pnpm ingest run` loaded the file with no identity warning
      ("File names … none of …")
- [ ] Spot-check 3 services on the site against the hospital's own price estimator
- [ ] `pnpm ingest payers:unmatched` shows no large unmatched payers for this hospital

## Expanding to a new county or region

1. In `data/registry/regions.json`, set the county's `"active": true` (all
   Southern California counties are already listed; add others under a new
   region such as `ca-norcal`).
2. Add a `data/registry/systems.json` entry for any new health system.
3. Add hospitals as above. Use the county's `_BACKLOG.md` to track candidates.
4. Add local help resources (e.g. that county's 211, county indigent care
   program) to `data/resources/programs.json` with `regions: ["<county-slug>"]`.
5. Add regional insurers (e.g. L.A. Care, CalOptima, Inland Empire Health Plan)
   to `data/payers/payers.json`.
6. Schedule `pnpm ingest run --region <region-slug>`.
