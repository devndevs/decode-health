# Test fixtures

**Synthetic data.** "Example General Hospital" does not exist and every price here
is made up. These files exist to exercise the parsers against each CMS template
layout and version:

| File | Layout | Template |
| --- | --- | --- |
| `v3-tall.csv` | CSV tall | 3.0.0 |
| `v3-wide.csv` | CSV wide | 3.0.0 |
| `v3.json` | JSON | 3.0.0 |
| `v2-tall.csv` | CSV tall | 2.2.0 (`hospital_location`, `estimated_amount`) |

They also intentionally include spec violations seen in real files
(`$1,234.00`, `N/A`, a CPT code labelled HCPCS, a lowercase setting) so the
lenient parsing paths stay covered.

Never load these under a real hospital's name. `pnpm ingest demo:seed` loads
them under a clearly fake "Sample Hospital" for local UI development.
