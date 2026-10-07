/**
 * Schemas for the hand-curated reference data in /data.
 *
 * The registry is "configuration as data": adding a hospital, a payer alias,
 * or a financial-help program is a JSON change reviewed in a pull request, not
 * a code change. `pnpm ingest registry:check` validates every file against
 * these schemas, and `registry:sync` upserts them into Postgres.
 */
import { z } from "zod";
import { SHOPPABLE_CODE_TYPES } from "./codes";
import { PRODUCT_TYPES } from "./payers";

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "lowercase-kebab-case slug");
const httpsUrl = z.url({ protocol: /^https$/ });
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

export const LocalizedTextSchema = z.object({
  en: z.string().min(1),
  /** Spanish. Optional so English-only drafts can land; the UI falls back to English. */
  es: z.string().min(1).optional(),
});
export type LocalizedText = z.infer<typeof LocalizedTextSchema>;

// ---------------------------------------------------------------------------
// Geography — a tree so coverage can grow county → region → state.
// ---------------------------------------------------------------------------

export const RegionSchema = z.object({
  slug,
  name: z.string().min(1),
  kind: z.enum(["state", "region", "county"]),
  parent: slug.nullable(),
  /** 5-digit county FIPS code, for counties. */
  fips: z.string().regex(/^\d{5}$/).optional(),
  /** Regions we're not ingesting yet stay in the tree but hidden from the UI. */
  active: z.boolean().default(false),
});
export type Region = z.infer<typeof RegionSchema>;

export const HealthSystemSchema = z.object({
  slug,
  name: z.string().min(1),
  website: httpsUrl.optional(),
});
export type HealthSystem = z.infer<typeof HealthSystemSchema>;

// ---------------------------------------------------------------------------
// Hospitals — one JSON file per licensed facility under
// data/registry/hospitals/<state>/<county>/<slug>.json
// ---------------------------------------------------------------------------

export const HospitalSchema = z.object({
  slug,
  name: z.string().min(1),
  system: slug.optional(),
  region: slug,
  address: z.object({
    line1: z.string().min(1),
    city: z.string().min(1),
    state: z.string().length(2),
    zip: z.string().regex(/^\d{5}$/),
  }),
  location: z.object({ lat: z.number(), lng: z.number() }).optional(),
  identifiers: z.object({
    /** CMS Certification Number (6 chars). */
    ccn: z.string().regex(/^[0-9A-Z]{6}$/).nullable(),
    /** Type 2 organizational NPIs. */
    npi: z.array(z.string().regex(/^\d{10}$/)),
    stateLicense: z.string().nullable(),
    /** California HCAI facility ID (formerly OSHPD ID). */
    hcaiId: z.string().nullable(),
  }),
  website: httpsUrl,
  phone: z.string().optional(),
  financialAssistanceUrl: httpsUrl.nullable(),
  priceTransparency: z.object({
    /** Every hospital must publish cms-hpt.txt at its site root; we discover file URLs from it. */
    cmsHptTxtUrl: httpsUrl.nullable(),
    /** Case-insensitive substrings matched against `location-name` in cms-hpt.txt. */
    locationNameMatch: z.array(z.string().min(1)).default([]),
    /** Pin a file URL here to skip discovery (e.g. when cms-hpt.txt is missing or wrong). */
    mrfUrl: httpsUrl.nullable(),
    sourcePageUrl: httpsUrl.nullable().default(null),
  }),
  /** Set true once a human has checked the identifiers, address, and file URL. */
  verified: z.boolean(),
  notes: z.string().optional(),
});
export type Hospital = z.infer<typeof HospitalSchema>;

// ---------------------------------------------------------------------------
// Payers
// ---------------------------------------------------------------------------

export const PayerSchema = z.object({
  slug,
  name: z.string().min(1),
  type: z.enum(["commercial", "medicare", "medicare_advantage", "medi_cal", "military", "workers_comp", "other"]),
  /** Raw spellings seen in hospital files. Matched after normalizeName(). */
  aliases: z.array(z.string().min(1)),
  /** See PayerAliasSource.prefixMatch. Set false for generic names like "Medicare". */
  prefixMatch: z.boolean().default(true),
  /** Product types this payer offers in our area, shown in the plan picker. */
  products: z.array(z.enum(PRODUCT_TYPES)).default([]),
});
export type Payer = z.infer<typeof PayerSchema>;

// ---------------------------------------------------------------------------
// Service catalog — consumer-friendly names mapped onto billing codes.
//
// IMPORTANT: CPT® descriptors are copyrighted by the AMA. Names and summaries
// here are our own plain-language descriptions. Do not paste CPT descriptor
// text into this file without a license.
// ---------------------------------------------------------------------------

export const SERVICE_CATEGORIES = [
  "office_visits",
  "preventive",
  "labs",
  "imaging",
  "procedures",
  "surgery",
  "hospital_stays",
  "maternity",
  "mental_health",
  "therapy",
  "emergency",
] as const;

export const BENEFIT_CATEGORIES = [
  "primary_care",
  "specialist",
  "preventive",
  "lab",
  "imaging",
  "advanced_imaging",
  "outpatient_surgery",
  "inpatient",
  "emergency",
  "mental_health",
  "rehab_therapy",
  "maternity",
] as const;
export type BenefitCategory = (typeof BENEFIT_CATEGORIES)[number];

export const ServiceComponentSchema = z.object({
  codeType: z.enum(SHOPPABLE_CODE_TYPES),
  code: z.string().min(1),
  billingClass: z.enum(["professional", "facility", "any"]).default("any"),
  label: LocalizedTextSchema,
});

export const ServiceSchema = z.object({
  slug,
  category: z.enum(SERVICE_CATEGORIES),
  benefitCategory: z.enum(BENEFIT_CATEGORIES),
  setting: z.enum(["inpatient", "outpatient"]),
  /** ACA-covered preventive service: $0 in-network for most plans. */
  acaPreventive: z.boolean().default(false),
  name: LocalizedTextSchema,
  summary: LocalizedTextSchema,
  /** The bill is usually several charges. Each component is priced separately and summed. */
  components: z.array(ServiceComponentSchema).min(1),
  keywords: z.array(z.string()).default([]),
});
export type Service = z.infer<typeof ServiceSchema>;
export type ServiceComponent = z.infer<typeof ServiceComponentSchema>;

// ---------------------------------------------------------------------------
// Financial help programs and reference tables
// ---------------------------------------------------------------------------

export const ProgramSchema = z.object({
  slug,
  kind: z.enum(["coverage", "discount", "clinic", "rights", "hotline"]),
  name: LocalizedTextSchema,
  summary: LocalizedTextSchema,
  url: httpsUrl,
  phone: z.string().optional(),
  /** Region slugs where this applies. "ca" = statewide. Matched against the person's region path. */
  regions: z.array(slug).min(1),
  /** null = informational, shown to everyone. */
  eligibility: z
    .object({
      maxFplPercent: z.number().positive().optional(),
      minFplPercent: z.number().nonnegative().optional(),
      minAge: z.number().int().nonnegative().optional(),
      maxAge: z.number().int().positive().optional(),
      pregnantOnly: z.boolean().optional(),
      uninsuredOnly: z.boolean().optional(),
    })
    .nullable(),
  /** Laws and thresholds change. Content is shown with a "needs review" badge until a human verifies it. */
  verified: z.boolean(),
  lastReviewed: isoDate,
  sources: z.array(httpsUrl).min(1),
});
export type Program = z.infer<typeof ProgramSchema>;

export const PovertyGuidelineSchema = z.object({
  year: z.number().int(),
  area: z.enum(["contiguous", "alaska", "hawaii"]),
  firstPerson: z.number().positive(),
  eachAdditional: z.number().positive(),
  source: httpsUrl,
});
export type PovertyGuideline = z.infer<typeof PovertyGuidelineSchema>;
