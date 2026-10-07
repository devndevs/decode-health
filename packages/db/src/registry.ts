/**
 * Load, validate, and sync the hand-curated reference data in /data.
 *
 *   data/registry/regions.json                      geography tree
 *   data/registry/systems.json                      health systems
 *   data/registry/hospitals/<state>/<county>/*.json one file per hospital
 *   data/payers/payers.json                         canonical payers + aliases
 *   data/services/*.json                            consumer service catalog
 *   data/resources/programs.json                    financial-help programs
 *   data/reference/poverty-guidelines.json          HHS poverty guidelines
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  buildPayerIndex,
  HealthSystemSchema,
  HospitalSchema,
  normalizeName,
  PayerSchema,
  PovertyGuidelineSchema,
  ProgramSchema,
  RegionSchema,
  SERVICE_CATEGORIES,
  ServiceSchema,
  type HealthSystem,
  type Hospital,
  type Payer,
  type PovertyGuideline,
  type Program,
  type Region,
  type Service,
} from "@decode-health/core";
import type { z } from "zod";
import { withTransaction, type Pool } from "./client";

export interface Registry {
  regions: Region[];
  systems: HealthSystem[];
  hospitals: Array<Hospital & { file: string }>;
  payers: Payer[];
  services: Service[];
  programs: Program[];
  povertyGuidelines: PovertyGuideline[];
}

export class RegistryError extends Error {
  constructor(public problems: string[]) {
    super(`Registry has ${problems.length} problem(s):\n  - ${problems.join("\n  - ")}`);
  }
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, "utf8"));
}

function parseAll<S extends z.ZodType>(schema: S, items: unknown, where: string, problems: string[]): z.infer<S>[] {
  if (!Array.isArray(items)) {
    problems.push(`${where}: expected a JSON array`);
    return [];
  }
  const out: z.infer<S>[] = [];
  items.forEach((item, i) => {
    const r = schema.safeParse(item);
    if (r.success) out.push(r.data);
    else problems.push(`${where}[${i}]: ${r.error.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("; ")}`);
  });
  return out;
}

function checkUnique(items: Array<{ slug: string }>, what: string, problems: string[]) {
  const seen = new Set<string>();
  for (const { slug } of items) {
    if (seen.has(slug)) problems.push(`Duplicate ${what} slug: ${slug}`);
    seen.add(slug);
  }
}

export async function loadRegistry(dataDir: string): Promise<Registry> {
  const problems: string[] = [];
  const p = (...parts: string[]) => path.join(dataDir, ...parts);

  const regions = parseAll(RegionSchema, await readJson(p("registry", "regions.json")), "regions.json", problems);
  const systems = parseAll(HealthSystemSchema, await readJson(p("registry", "systems.json")), "systems.json", problems);
  const payers = parseAll(PayerSchema, await readJson(p("payers", "payers.json")), "payers.json", problems);
  const programs = parseAll(ProgramSchema, await readJson(p("resources", "programs.json")), "programs.json", problems);
  const povertyGuidelines = parseAll(
    PovertyGuidelineSchema,
    await readJson(p("reference", "poverty-guidelines.json")),
    "poverty-guidelines.json",
    problems,
  );

  const services: Service[] = [];
  for (const f of (await readdir(p("services"))).filter((f) => f.endsWith(".json") && !f.startsWith("_")).sort()) {
    services.push(...parseAll(ServiceSchema, await readJson(p("services", f)), `services/${f}`, problems));
  }

  const hospitals: Registry["hospitals"] = [];
  const hospitalRoot = p("registry", "hospitals");
  const files = (await readdir(hospitalRoot, { recursive: true }))
    .map(String)
    .filter((f) => f.endsWith(".json") && !path.basename(f).startsWith("_"))
    .sort();
  for (const rel of files) {
    const r = HospitalSchema.safeParse(await readJson(path.join(hospitalRoot, rel)));
    if (!r.success) {
      problems.push(`hospitals/${rel}: ${r.error.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("; ")}`);
      continue;
    }
    hospitals.push({ ...r.data, file: rel });
  }

  // Cross-references -------------------------------------------------------
  checkUnique(regions, "region", problems);
  checkUnique(systems, "system", problems);
  checkUnique(hospitals, "hospital", problems);
  checkUnique(payers, "payer", problems);
  checkUnique(services, "service", problems);
  checkUnique(programs, "program", problems);

  const regionBySlug = new Map(regions.map((r) => [r.slug, r]));
  const systemSlugs = new Set(systems.map((s) => s.slug));
  for (const r of regions) {
    if (r.parent && !regionBySlug.has(r.parent)) problems.push(`Region ${r.slug}: unknown parent ${r.parent}`);
  }
  for (const h of hospitals) {
    const region = regionBySlug.get(h.region);
    if (!region) problems.push(`hospitals/${h.file}: unknown region ${h.region}`);
    else if (region.kind !== "county") problems.push(`hospitals/${h.file}: region must be a county, got ${region.kind}`);
    // Directory layout mirrors geography: hospitals/ca/san-diego-county/x.json ↔ region ca-san-diego-county
    const [state, county] = h.file.split(path.sep);
    if (`${state}-${county}` !== h.region) {
      problems.push(`hospitals/${h.file}: file should live in hospitals/${h.region.replace("-", "/")}/ to match its region`);
    }
    if (path.basename(h.file, ".json") !== h.slug) problems.push(`hospitals/${h.file}: filename must equal slug "${h.slug}"`);
    if (h.system && !systemSlugs.has(h.system)) problems.push(`hospitals/${h.file}: unknown system ${h.system}`);
  }
  for (const pr of programs) {
    for (const rs of pr.regions) if (!regionBySlug.has(rs)) problems.push(`Program ${pr.slug}: unknown region ${rs}`);
  }
  try {
    buildPayerIndex(payers);
  } catch (err) {
    problems.push((err as Error).message);
  }

  if (problems.length) throw new RegistryError(problems);
  return { regions, systems, hospitals, payers, services, programs, povertyGuidelines };
}

/** Parents before children, so parent ids exist when children are inserted. */
function topoSortRegions(regions: Region[]): Array<Region & { path: string }> {
  const bySlug = new Map(regions.map((r) => [r.slug, r]));
  const pathOf = (r: Region, guard = 0): string => {
    if (guard > 20) throw new Error(`Region cycle at ${r.slug}`);
    const parent = r.parent ? bySlug.get(r.parent) : undefined;
    return parent ? `${pathOf(parent, guard + 1)}/${r.slug}` : r.slug;
  };
  return regions
    .map((r) => ({ ...r, path: pathOf(r) }))
    .sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path));
}

export interface SyncResult {
  regions: number;
  systems: number;
  hospitals: number;
  payers: number;
  services: number;
  /** Hospitals in the DB that are no longer in the registry. Never auto-deleted (they may hold data). */
  orphanedHospitals: string[];
}

export async function syncRegistry(pool: Pool, reg: Registry): Promise<SyncResult> {
  return withTransaction(pool, async (c) => {
    for (const r of topoSortRegions(reg.regions)) {
      await c.query(
        `INSERT INTO regions (slug, name, kind, parent_id, path, fips, active)
         VALUES ($1, $2, $3, (SELECT id FROM regions WHERE slug = $4), $5, $6, $7)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind, parent_id = EXCLUDED.parent_id,
           path = EXCLUDED.path, fips = EXCLUDED.fips, active = EXCLUDED.active`,
        [r.slug, r.name, r.kind, r.parent, r.path, r.fips ?? null, r.active],
      );
    }

    for (const s of reg.systems) {
      await c.query(
        `INSERT INTO health_systems (slug, name, website) VALUES ($1, $2, $3)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, website = EXCLUDED.website`,
        [s.slug, s.name, s.website ?? null],
      );
    }

    for (const h of reg.hospitals) {
      await c.query(
        `INSERT INTO hospitals (slug, name, system_id, region_id, address_line1, city, state, zip, lat, lng,
           ccn, npis, state_license, hcai_id, website, phone, financial_assistance_url,
           cms_hpt_txt_url, location_name_match, mrf_urls_pinned, source_page_url, verified, campuses)
         VALUES ($1, $2, (SELECT id FROM health_systems WHERE slug = $3), (SELECT id FROM regions WHERE slug = $4),
           $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, system_id = EXCLUDED.system_id,
           region_id = EXCLUDED.region_id, address_line1 = EXCLUDED.address_line1, city = EXCLUDED.city,
           state = EXCLUDED.state, zip = EXCLUDED.zip, lat = EXCLUDED.lat, lng = EXCLUDED.lng, ccn = EXCLUDED.ccn,
           npis = EXCLUDED.npis, state_license = EXCLUDED.state_license, hcai_id = EXCLUDED.hcai_id,
           website = EXCLUDED.website, phone = EXCLUDED.phone,
           financial_assistance_url = EXCLUDED.financial_assistance_url, cms_hpt_txt_url = EXCLUDED.cms_hpt_txt_url,
           location_name_match = EXCLUDED.location_name_match, mrf_urls_pinned = EXCLUDED.mrf_urls_pinned,
           campuses = EXCLUDED.campuses,
           source_page_url = COALESCE(EXCLUDED.source_page_url, hospitals.source_page_url),
           verified = EXCLUDED.verified, updated_at = now()`,
        [
          h.slug, h.name, h.system ?? null, h.region, h.address.line1, h.address.city, h.address.state, h.address.zip,
          h.location?.lat ?? null, h.location?.lng ?? null, h.identifiers.ccn, h.identifiers.npi,
          h.identifiers.stateLicense, h.identifiers.hcaiId, h.website, h.phone ?? null, h.financialAssistanceUrl,
          h.priceTransparency.cmsHptTxtUrl, h.priceTransparency.locationNameMatch, h.priceTransparency.mrfUrls,
          h.priceTransparency.sourcePageUrl, h.verified, JSON.stringify(h.campuses),
        ],
      );
    }

    for (const p of reg.payers) {
      const { rows } = await c.query<{ id: number }>(
        `INSERT INTO payers (slug, name, payer_type, prefix_match) VALUES ($1, $2, $3, $4)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, payer_type = EXCLUDED.payer_type,
           prefix_match = EXCLUDED.prefix_match
         RETURNING id`,
        [p.slug, p.name, p.type, p.prefixMatch],
      );
      const payerId = rows[0]!.id;
      const aliases = [...new Set([p.name, p.slug.replace(/-/g, " "), ...p.aliases].map(normalizeName).filter(Boolean))];
      await c.query("DELETE FROM payer_aliases WHERE payer_id = $1", [payerId]);
      await c.query(
        "INSERT INTO payer_aliases (alias, payer_id) SELECT unnest($1::text[]), $2",
        [aliases, payerId],
      );
      await c.query("DELETE FROM payer_products WHERE payer_id = $1", [payerId]);
      await c.query(
        "INSERT INTO payer_products (payer_id, product_type) SELECT $1, unnest($2::text[])",
        [payerId, p.products],
      );
    }

    // Catalog order follows SERVICE_CATEGORIES (office visits first), then file order.
    const ordered = [...reg.services].sort(
      (a, b) => SERVICE_CATEGORIES.indexOf(a.category) - SERVICE_CATEGORIES.indexOf(b.category),
    );
    let order = 0;
    for (const s of ordered) {
      const { rows } = await c.query<{ id: number }>(
        `INSERT INTO services (slug, category, benefit_category, setting, aca_preventive, name, summary, keywords, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (slug) DO UPDATE SET category = EXCLUDED.category, benefit_category = EXCLUDED.benefit_category,
           setting = EXCLUDED.setting, aca_preventive = EXCLUDED.aca_preventive, name = EXCLUDED.name,
           summary = EXCLUDED.summary, keywords = EXCLUDED.keywords, sort_order = EXCLUDED.sort_order
         RETURNING id`,
        [s.slug, s.category, s.benefitCategory, s.setting, s.acaPreventive, s.name, s.summary, s.keywords, order++],
      );
      const serviceId = rows[0]!.id;
      await c.query("DELETE FROM service_components WHERE service_id = $1", [serviceId]);
      for (const [i, comp] of s.components.entries()) {
        await c.query(
          `INSERT INTO service_components (service_id, position, code_type, code, billing_class, label)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [serviceId, i, comp.codeType, comp.code, comp.billingClass, comp.label],
        );
      }
    }

    const known = reg.hospitals.map((h) => h.slug);
    const { rows: orphans } = await c.query<{ slug: string }>(
      "SELECT slug FROM hospitals WHERE NOT (slug = ANY($1::text[])) ORDER BY slug",
      [known],
    );

    return {
      regions: reg.regions.length,
      systems: reg.systems.length,
      hospitals: reg.hospitals.length,
      payers: reg.payers.length,
      services: reg.services.length,
      orphanedHospitals: orphans.map((o) => o.slug),
    };
  });
}
