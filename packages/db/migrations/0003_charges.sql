-- The big tables. Every one is LIST-partitioned by hospital_id, one partition
-- per hospital, named <table>_h<hospital_id>_f<mrf_file_id>_<load tag>.
--
-- Why: a hospital's file is replaced wholesale when they publish a new one.
-- The loader builds the new partition off to the side (COPY, index, ANALYZE),
-- then swaps it in with DETACH/ATTACH in a single short transaction. Readers
-- never see a half-loaded hospital, and dropping the old version is instant
-- (no DELETE, no vacuum bloat). See packages/db/src/load.ts.
--
-- No foreign keys on these tables on purpose: they'd slow bulk loads, and the
-- loader guarantees integrity because it writes all three tables from one parse.

CREATE TABLE charge_items (
  hospital_id      int NOT NULL,
  item_id          int NOT NULL,           -- sequence within the file
  mrf_file_id      bigint NOT NULL,
  description      text NOT NULL,
  setting          text,                   -- inpatient | outpatient | both
  billing_class    text,                   -- professional | facility | both
  modifiers        text[] NOT NULL DEFAULT '{}',
  drug_unit        numeric,
  drug_unit_type   text,
  gross            numeric(14, 2),
  discounted_cash  numeric(14, 2),
  min_negotiated   numeric(14, 2),
  max_negotiated   numeric(14, 2),
  notes            text,
  PRIMARY KEY (hospital_id, item_id)
) PARTITION BY LIST (hospital_id);

CREATE TABLE charge_item_codes (
  hospital_id  int NOT NULL,
  item_id      int NOT NULL,
  code_type    text NOT NULL,
  code         text NOT NULL
) PARTITION BY LIST (hospital_id);
CREATE INDEX charge_item_codes_code_idx ON charge_item_codes (code_type, code, item_id);
CREATE INDEX charge_item_codes_item_idx ON charge_item_codes (item_id);

CREATE TABLE charge_rates (
  hospital_id            int NOT NULL,
  item_id                int NOT NULL,
  payer_plan_id          int NOT NULL,     -- raw_payer_plans.id
  negotiated_dollar      numeric(14, 2),
  negotiated_percentage  numeric(9, 4),
  negotiated_algorithm   text,
  median_allowed         numeric(14, 2),   -- CMS template v3.0+
  p10_allowed            numeric(14, 2),
  p90_allowed            numeric(14, 2),
  allowed_count          text,
  estimated_amount       numeric(14, 2),   -- CMS template v2.x
  methodology            text,
  -- One comparable dollar figure, derived at parse time (see effectiveAmount in core).
  effective_amount       numeric(14, 2),
  effective_basis        text,
  notes                  text
) PARTITION BY LIST (hospital_id);
CREATE INDEX charge_rates_item_idx ON charge_rates (item_id, payer_plan_id);
CREATE INDEX charge_rates_payer_plan_idx ON charge_rates (payer_plan_id);

-- Pre-aggregated prices per (hospital, code) for fast search and comparison.
-- Rebuilt per hospital after each load (`pnpm ingest summarize`) and after
-- payer re-matching. Only shoppable code types (CPT, HCPCS, DRGs) are summarized.
CREATE TABLE price_summary (
  hospital_id    int NOT NULL REFERENCES hospitals (id) ON DELETE CASCADE,
  code_type      text NOT NULL,
  code           text NOT NULL,
  setting        text NOT NULL,          -- inpatient | outpatient | both | unknown
  billing_class  text NOT NULL,          -- professional | facility | both | unknown
  scope          text NOT NULL CHECK (scope IN ('cash', 'gross', 'all_payers', 'payer', 'payer_product')),
  payer_id       int NOT NULL DEFAULT 0, -- 0 when scope isn't payer-specific
  product_type   text NOT NULL DEFAULT '',
  n              int NOT NULL,
  min            numeric(14, 2) NOT NULL,
  p25            numeric(14, 2) NOT NULL,
  median         numeric(14, 2) NOT NULL,
  p75            numeric(14, 2) NOT NULL,
  max            numeric(14, 2) NOT NULL,
  computed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (code_type, code, hospital_id, setting, billing_class, scope, payer_id, product_type)
);
CREATE INDEX price_summary_hospital_idx ON price_summary (hospital_id);
