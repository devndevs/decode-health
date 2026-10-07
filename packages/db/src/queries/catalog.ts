/** Read-only queries for regions, hospitals, payers, and the service catalog. */
import type { LocalizedText } from "@decode-health/core";
import type { Pool } from "../client";

export interface RegionRow {
  slug: string;
  name: string;
  kind: "state" | "region" | "county";
  path: string;
  hospital_count: number;
}

export async function listActiveRegions(pool: Pool): Promise<RegionRow[]> {
  const { rows } = await pool.query<RegionRow>(
    `SELECT r.slug, r.name, r.kind, r.path,
            (SELECT count(*)::int FROM hospitals h JOIN regions hr ON hr.id = h.region_id
             WHERE hr.path = r.path OR hr.path LIKE r.path || '/%') AS hospital_count
     FROM regions r WHERE r.active ORDER BY r.path`,
  );
  return rows;
}

export interface HospitalListRow {
  id: number;
  slug: string;
  name: string;
  city: string;
  region_name: string;
  system_name: string | null;
  last_updated_on: string | null;
  has_prices: boolean;
}

export async function listHospitals(pool: Pool, regionSlug?: string): Promise<HospitalListRow[]> {
  const { rows } = await pool.query<HospitalListRow>(
    `SELECT h.id, h.slug, h.name, h.city, r.name AS region_name, s.name AS system_name,
            to_char(f.last_updated_on, 'YYYY-MM-DD') AS last_updated_on,
            h.current_mrf_file_id IS NOT NULL AS has_prices
     FROM hospitals h
     JOIN regions r ON r.id = h.region_id
     LEFT JOIN health_systems s ON s.id = h.system_id
     LEFT JOIN mrf_files f ON f.id = h.current_mrf_file_id
     WHERE $1::text IS NULL
        OR r.path = (SELECT path FROM regions WHERE slug = $1)
        OR r.path LIKE (SELECT path FROM regions WHERE slug = $1) || '/%'
     ORDER BY h.name`,
    [regionSlug ?? null],
  );
  return rows;
}

export interface HospitalDetail extends HospitalListRow {
  campuses: Array<{ name: string; address: string }>;
  address_line1: string;
  state: string;
  zip: string;
  website: string;
  phone: string | null;
  financial_assistance_url: string | null;
  source_page_url: string | null;
  region_path: string;
  verified: boolean;
  template_version: string | null;
  fetched_at: Date | null;
}

export async function getHospital(pool: Pool, slug: string): Promise<HospitalDetail | null> {
  const { rows } = await pool.query<HospitalDetail>(
    `SELECT h.id, h.slug, h.name, h.city, r.name AS region_name, s.name AS system_name,
            to_char(f.last_updated_on, 'YYYY-MM-DD') AS last_updated_on,
            h.current_mrf_file_id IS NOT NULL AS has_prices,
            h.campuses, h.address_line1, h.state, h.zip, h.website, h.phone, h.financial_assistance_url, h.source_page_url,
            r.path AS region_path, h.verified, f.template_version, f.fetched_at
     FROM hospitals h
     JOIN regions r ON r.id = h.region_id
     LEFT JOIN health_systems s ON s.id = h.system_id
     LEFT JOIN mrf_files f ON f.id = h.current_mrf_file_id
     WHERE h.slug = $1`,
    [slug],
  );
  return rows[0] ?? null;
}

export interface PayerRow {
  id: number;
  slug: string;
  name: string;
  payer_type: string;
  products: string[];
}

export async function listPayers(pool: Pool): Promise<PayerRow[]> {
  const { rows } = await pool.query<PayerRow>(
    `SELECT p.id, p.slug, p.name, p.payer_type,
            COALESCE(array_agg(pp.product_type ORDER BY pp.product_type) FILTER (WHERE pp.product_type IS NOT NULL), '{}') AS products
     FROM payers p LEFT JOIN payer_products pp ON pp.payer_id = p.id
     GROUP BY p.id ORDER BY p.name`,
  );
  return rows;
}

export interface ServiceRow {
  id: number;
  slug: string;
  category: string;
  benefit_category: string;
  setting: "inpatient" | "outpatient";
  aca_preventive: boolean;
  name: LocalizedText;
  summary: LocalizedText;
}

export interface ServiceComponentRow {
  code_type: string;
  code: string;
  billing_class: "professional" | "facility" | "any";
  label: LocalizedText;
}

export async function listServices(pool: Pool, opts: { category?: string; q?: string } = {}): Promise<ServiceRow[]> {
  const q = opts.q?.trim() ? `%${opts.q.trim().replace(/[%_\\]/g, "\\$&")}%` : null;
  const { rows } = await pool.query<ServiceRow>(
    `SELECT s.id, s.slug, s.category, s.benefit_category, s.setting, s.aca_preventive, s.name, s.summary
     FROM services s
     WHERE ($1::text IS NULL OR s.category = $1)
       AND ($2::text IS NULL
            OR s.name->>'en' ILIKE $2 OR s.name->>'es' ILIKE $2
            OR EXISTS (SELECT 1 FROM unnest(s.keywords) k WHERE k ILIKE $2)
            OR EXISTS (SELECT 1 FROM service_components c WHERE c.service_id = s.id AND c.code ILIKE $2))
     ORDER BY s.sort_order`,
    [opts.category ?? null, q],
  );
  return rows;
}

export async function getService(pool: Pool, slug: string): Promise<(ServiceRow & { components: ServiceComponentRow[] }) | null> {
  const { rows } = await pool.query<ServiceRow & { components: ServiceComponentRow[] }>(
    `SELECT s.id, s.slug, s.category, s.benefit_category, s.setting, s.aca_preventive, s.name, s.summary,
            COALESCE((SELECT json_agg(json_build_object('code_type', c.code_type, 'code', c.code,
                        'billing_class', c.billing_class, 'label', c.label) ORDER BY c.position)
                      FROM service_components c WHERE c.service_id = s.id), '[]') AS components
     FROM services s WHERE s.slug = $1`,
    [slug],
  );
  return rows[0] ?? null;
}

/** Every service with its components, in catalog order (one query). */
export async function listServicesWithComponents(pool: Pool): Promise<Array<ServiceRow & { components: ServiceComponentRow[] }>> {
  const { rows } = await pool.query<ServiceRow & { components: ServiceComponentRow[] }>(
    `SELECT s.id, s.slug, s.category, s.benefit_category, s.setting, s.aca_preventive, s.name, s.summary,
            COALESCE((SELECT json_agg(json_build_object('code_type', c.code_type, 'code', c.code,
                        'billing_class', c.billing_class, 'label', c.label) ORDER BY c.position)
                      FROM service_components c WHERE c.service_id = s.id), '[]') AS components
     FROM services s ORDER BY s.sort_order`,
  );
  return rows;
}
