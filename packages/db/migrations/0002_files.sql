-- One row per distinct version of a hospital's machine-readable file (MRF).
-- A version may be split into several part files; `parts` lists each one
-- ({url, storageKey, sha256, sizeBytes, etag, lastModified}) and the columns
-- below describe the first part. Raw bytes live in object storage; this is the
-- index + audit trail.

CREATE TABLE mrf_files (
  id                     bigserial PRIMARY KEY,
  hospital_id            int NOT NULL REFERENCES hospitals (id),
  source_url             text NOT NULL,
  storage_key            text NOT NULL,
  -- SHA-256 of the file, or of the ordered part hashes for multi-part files.
  sha256                 char(64) NOT NULL,
  size_bytes             bigint NOT NULL,      -- total across parts
  parts                  jsonb NOT NULL DEFAULT '[]',
  etag                   text,
  last_modified          text,
  format                 text CHECK (format IN ('csv_tall', 'csv_wide', 'json')),
  template_version       text,
  last_updated_on        date,          -- the date the hospital says the file was updated
  hospital_name_in_file  text,
  location_names         text[],
  attester_name          text,
  status                 text NOT NULL DEFAULT 'fetched'
                         CHECK (status IN ('fetched', 'parsed', 'loaded', 'superseded', 'failed')),
  stats                  jsonb NOT NULL DEFAULT '{}',
  error                  text,
  fetched_at             timestamptz NOT NULL DEFAULT now(),
  parsed_at              timestamptz,
  loaded_at              timestamptz,
  UNIQUE (hospital_id, sha256)
);
CREATE INDEX mrf_files_hospital_idx ON mrf_files (hospital_id, fetched_at DESC);

ALTER TABLE hospitals
  ADD COLUMN current_mrf_file_id bigint REFERENCES mrf_files (id);

-- Every distinct (payer, plan) spelling seen in any file, stored once.
-- Rates reference this by id instead of repeating the strings millions of times,
-- and re-matching a spelling to a payer instantly applies to every stored rate.
CREATE TABLE raw_payer_plans (
  id            serial PRIMARY KEY,
  payer_name    text NOT NULL,
  plan_name     text NOT NULL,
  payer_key     text NOT NULL,   -- normalizeName(payer_name)
  plan_key      text NOT NULL,   -- normalizeName(plan_name)
  payer_id      int REFERENCES payers (id),
  match_method  text CHECK (match_method IN ('exact', 'prefix', 'manual')),
  product_type  text NOT NULL DEFAULT 'other',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payer_key, plan_key)
);
CREATE INDEX raw_payer_plans_payer_idx ON raw_payer_plans (payer_id, product_type);
