/**
 * Static reference content bundled at build time from /data and validated with
 * the same schemas the ingest CLI uses. A bad edit fails the build, not a page.
 */
import "server-only";
import { PovertyGuidelineSchema, ProgramSchema } from "@decode-health/core";
import guidelinesJson from "../../../../data/reference/poverty-guidelines.json";
import programsJson from "../../../../data/resources/programs.json";

export const programs = ProgramSchema.array().parse(programsJson);

const guidelines = PovertyGuidelineSchema.array().parse(guidelinesJson);
/** Most recent guideline for the 48 contiguous states (California). */
export const povertyGuideline = guidelines
  .filter((g) => g.area === "contiguous")
  .sort((a, b) => b.year - a.year)[0]!;

export const DEFAULT_REGION = "ca-san-diego-county";
