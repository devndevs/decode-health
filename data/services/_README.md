# Service catalog

Consumer-friendly services mapped to the billing codes that make up the bill.
One JSON array per category. Files starting with `_` are ignored.

- **Write names and summaries yourself, in plain language** (aim for a 6th–8th
  grade reading level). CPT® code descriptors are copyrighted by the American
  Medical Association; don't paste them here without a license.
- **List every charge a person is likely to see** as a separate component, for
  example the doctor's fee (professional) and the hospital clinic fee (facility).
  The estimator prices each one and says when a component has no data.
- If the same code is billed by both the hospital and the doctor, use one
  component with `"billingClass": "any"` to avoid double counting.
- Spanish (`es`) is optional per entry; the site falls back to English. Have a
  qualified medical translator review Spanish text before launch.
