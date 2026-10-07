-- Reference data synced from /data by `pnpm ingest registry:sync`.
-- These tables are small (thousands of rows even statewide).

CREATE TABLE regions (
  id         serial PRIMARY KEY,
  slug       text NOT NULL UNIQUE,
  name       text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('state', 'region', 'county')),
  parent_id  int REFERENCES regions (id),
  -- Slash-joined slugs from the root, e.g. 'ca/ca-socal/ca-san-diego-county'.
  -- "Everything in SoCal" is a prefix match on path.
  path       text NOT NULL UNIQUE,
  fips       text,
  active     boolean NOT NULL DEFAULT false
);
CREATE INDEX regions_path_idx ON regions (path text_pattern_ops);

CREATE TABLE health_systems (
  id       serial PRIMARY KEY,
  slug     text NOT NULL UNIQUE,
  name     text NOT NULL,
  website  text
);

CREATE TABLE hospitals (
  id                        serial PRIMARY KEY,
  slug                      text NOT NULL UNIQUE,
  name                      text NOT NULL,
  system_id                 int REFERENCES health_systems (id),
  region_id                 int NOT NULL REFERENCES regions (id),
  address_line1             text NOT NULL,
  city                      text NOT NULL,
  state                     char(2) NOT NULL,
  zip                       text NOT NULL,
  lat                       double precision,
  lng                       double precision,
  ccn                       text,
  npis                      text[] NOT NULL DEFAULT '{}',
  state_license             text,
  hcai_id                   text,
  website                   text NOT NULL,
  phone                     text,
  financial_assistance_url  text,
  -- Campuses covered by this license's price file: [{"name": ..., "address": ...}]
  campuses                  jsonb NOT NULL DEFAULT '[]',
  cms_hpt_txt_url           text,
  location_name_match       text[] NOT NULL DEFAULT '{}',
  -- A hospital's file may be split into parts (UC San Diego publishes 33).
  mrf_urls_pinned           text[] NOT NULL DEFAULT '{}',
  mrf_urls_discovered       text[] NOT NULL DEFAULT '{}',
  source_page_url           text,
  discovered_at             timestamptz,
  verified                  boolean NOT NULL DEFAULT false,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hospitals_region_idx ON hospitals (region_id);

CREATE TABLE payers (
  id            serial PRIMARY KEY,
  slug          text NOT NULL UNIQUE,
  name          text NOT NULL,
  payer_type    text NOT NULL,
  prefix_match  boolean NOT NULL DEFAULT true
);

-- Normalized spellings (see normalizeName in @decode-health/core) → canonical payer.
CREATE TABLE payer_aliases (
  alias     text PRIMARY KEY,
  payer_id  int NOT NULL REFERENCES payers (id) ON DELETE CASCADE
);

-- Which product types to offer in the plan picker for each payer.
CREATE TABLE payer_products (
  payer_id      int NOT NULL REFERENCES payers (id) ON DELETE CASCADE,
  product_type  text NOT NULL,
  PRIMARY KEY (payer_id, product_type)
);

CREATE TABLE services (
  id                serial PRIMARY KEY,
  slug              text NOT NULL UNIQUE,
  category          text NOT NULL,
  benefit_category  text NOT NULL,
  setting           text NOT NULL CHECK (setting IN ('inpatient', 'outpatient')),
  aca_preventive    boolean NOT NULL DEFAULT false,
  name              jsonb NOT NULL,   -- {"en": "...", "es": "..."}
  summary           jsonb NOT NULL,
  keywords          text[] NOT NULL DEFAULT '{}',
  sort_order        int NOT NULL DEFAULT 0
);

CREATE TABLE service_components (
  service_id     int NOT NULL REFERENCES services (id) ON DELETE CASCADE,
  position       int NOT NULL,
  code_type      text NOT NULL,
  code           text NOT NULL,
  billing_class  text NOT NULL CHECK (billing_class IN ('professional', 'facility', 'any')),
  label          jsonb NOT NULL,
  PRIMARY KEY (service_id, position)
);
CREATE INDEX service_components_code_idx ON service_components (code_type, code);
