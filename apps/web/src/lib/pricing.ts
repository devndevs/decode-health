/** Server-side glue between database price lookups and the core estimator. */
import "server-only";
import { estimateCost, type Range } from "@decode-health/core";
import {
  componentPricing,
  listHospitals,
  type ComponentSpec,
  type HospitalListRow,
  type Pool,
  type ServiceComponentRow,
  type ServiceRow,
} from "@decode-health/db";
import { pick } from "./text";

export function componentSpecs(components: ServiceComponentRow[], locale: string): ComponentSpec[] {
  return components.map((c) => ({
    codeType: c.code_type,
    code: c.code,
    billingClass: c.billing_class,
    label: pick(c.label, locale),
  }));
}

/** Placeholder benefits used only to compute the allowed (total) amount, not what the person pays. */
const ALLOWED_ONLY = {
  kind: "insured" as const,
  benefits: { deductibleRemaining: 0, deductibleApplies: false, afterDeductible: { type: "copay" as const, amount: 0 }, oopMaxRemaining: null },
};

export interface HospitalPriceRow {
  hospital: HospitalListRow;
  cash: Range | null;
  insured: Range | null;
  partial: boolean;
}

/** Cash and typical insured price for one service at every priced hospital in a region, cheapest first. */
export async function compareAcrossHospitals(
  pool: Pool,
  service: ServiceRow & { components: ServiceComponentRow[] },
  regionSlug: string,
  locale: string,
): Promise<HospitalPriceRow[]> {
  const hospitals = (await listHospitals(pool, regionSlug)).filter((h) => h.has_prices);
  if (!hospitals.length) return [];
  const pricing = await componentPricing(pool, {
    hospitalIds: hospitals.map((h) => h.id),
    components: componentSpecs(service.components, locale),
    setting: service.setting,
  });
  return hospitals
    .map((hospital) => {
      const components = pricing.get(hospital.id) ?? [];
      const cash = estimateCost({ components, coverage: { kind: "uninsured" } });
      const insured = estimateCost({ components, coverage: ALLOWED_ONLY });
      return {
        hospital,
        cash: cash.patient,
        insured: insured.allowed,
        partial: cash.missing.length > 0 || insured.missing.length > 0,
      };
    })
    .filter((r) => r.cash || r.insured)
    .sort((a, b) => (a.cash?.typical ?? Infinity) - (b.cash?.typical ?? Infinity));
}

/** Cash price for every catalog service at one hospital (one query). */
export async function cashPricesAtHospital(
  pool: Pool,
  hospitalId: number,
  services: Array<ServiceRow & { components: ServiceComponentRow[] }>,
  locale: string,
): Promise<Map<string, Range>> {
  const out = new Map<string, Range>();
  for (const setting of ["outpatient", "inpatient"] as const) {
    const group = services.filter((s) => s.setting === setting);
    if (!group.length) continue;
    const keyOf = (c: ComponentSpec) => `${c.codeType}:${c.code}:${c.billingClass}`;
    const specs = new Map<string, ComponentSpec>();
    for (const s of group) for (const c of componentSpecs(s.components, locale)) specs.set(keyOf(c), c);
    const priced = (await componentPricing(pool, { hospitalIds: [hospitalId], components: [...specs.values()], setting })).get(hospitalId) ?? [];
    const byKey = new Map([...specs.keys()].map((k, i) => [k, priced[i]!]));
    for (const s of group) {
      const comps = componentSpecs(s.components, locale).map((c) => ({ ...byKey.get(keyOf(c))!, label: c.label }));
      const r = estimateCost({ components: comps, coverage: { kind: "uninsured" } });
      if (r.patient && !r.missing.length) out.set(s.slug, r.patient);
    }
  }
  return out;
}
