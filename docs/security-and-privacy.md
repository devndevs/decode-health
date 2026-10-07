# Security & privacy

## TL;DR

The safest health data is the data you never collect. The site needs **no
account and stores no personal or health information**. Everything sensitive a
person types — plan details, income, household — is processed in their browser
and never sent to our servers. The only data we store is public hospital price
data.

## What we collect

| Input | Where it goes |
| --- | --- |
| Deductible, coinsurance, copay, out-of-pocket max | Browser only (`EstimateCalculator`) |
| Income, household size, age, pregnancy, insured? | Browser only (`HelpScreener`) |
| Hospital, service, insurer, plan type | URL query string → server (needed to look up prices). Not linked to any identity. |

Keep it this way. If you ever add accounts, saved estimates, or analytics,
redo this review first: combined with identity, even "which insurer and which
service" can become sensitive health information. Do not add third-party
analytics or ad scripts; the CSP blocks them by default.

## Website controls

- **Read-only database role** (`decode_web`): `SELECT` only,
  `default_transaction_read_only`, 5 s statement timeout. The site cannot
  modify data even if compromised.
- **Strict Content-Security-Policy** with a per-request nonce
  (`apps/web/src/proxy.ts`): no inline scripts, no third-party origins,
  `frame-ancestors 'none'`.
- **Headers** (`next.config.ts`): HSTS, `nosniff`, `X-Frame-Options: DENY`,
  strict referrer policy, Permissions-Policy denying camera/mic/location.
- **Input validation**: route params are matched against known slugs and enums
  before use; all SQL is parameterized; generated identifiers (partition names)
  pass an allow-list check (`ident()` in `packages/db/src/client.ts`).
- **No secrets in the client bundle**: database code is `server-only`.

## Ingest controls

Hospital files come from the open internet; treat them as untrusted.

- HTTPS only, public-IP-only hosts, re-validated redirects (SSRF guard).
- Byte caps on downloads and on decompressed size (zip/gzip bomb guard).
- Streaming parsers with a per-record size cap and a JSON nesting limit.
- Raw files are never executed or rendered; text is stored as data and
  React escapes it on output.
- Run ingest as an **isolated job** with its own DB role (owner of the fact
  tables), memory limits, and no access to website secrets. A malformed file
  can at worst crash the job; the site keeps serving the previous data.

Known gap: DNS is resolved once for the safety check and again by `fetch`
(a DNS-rebinding window). Close it by routing ingest egress through a proxy
that enforces the same public-IP rule, or pin the resolved address.

## Before launch

- [ ] Rate limiting / bot protection at the CDN or load balancer
- [ ] Error monitoring that scrubs query strings
- [ ] Real secrets in a secret manager; rotate the example passwords
- [ ] Dependency updates automated (Dependabot/Renovate) and `pnpm audit` in CI
- [ ] Legal review of disclaimers, the CPT license question, and content accuracy
- [ ] Human review of every `verified: false` registry and program entry
- [ ] Professional review of Spanish medical and legal wording
- [ ] Accessibility audit with real assistive-technology users
