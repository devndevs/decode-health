import Link from "next/link";
import { listActiveRegions, listHospitals } from "@decode-health/db";
import { UnverifiedBadge } from "@/components/Badges";
import { DEFAULT_REGION } from "@/lib/content";
import { withDb } from "@/lib/db";
import { fmt, resolveLocale } from "@/lib/i18n";

type Props = { params: Promise<{ locale: string }>; searchParams: Promise<{ region?: string }> };

export async function generateMetadata({ params }: Props) {
  const { t } = await resolveLocale(params);
  return { title: t.hospitals.title };
}

export default async function HospitalsPage({ params, searchParams }: Props) {
  const { locale, t } = await resolveLocale(params);
  const requested = (await searchParams).region;
  const data = await withDb(async (pool) => {
    const regions = await listActiveRegions(pool);
    const region = regions.find((r) => r.slug === requested) ?? regions.find((r) => r.slug === DEFAULT_REGION) ?? regions[0];
    return { regions, region, hospitals: region ? await listHospitals(pool, region.slug) : [] };
  });
  if (data == null) return <p role="status">{t.common.dataUnavailable}</p>;
  const { regions, region, hospitals } = data;

  return (
    <>
      <h1>{t.hospitals.title}</h1>
      <p className="lead">{fmt(t.hospitals.intro, { region: region?.name ?? "" })}</p>
      {regions.length > 1 && (
        <form method="get" className="inline-form">
          <label htmlFor="region">{t.common.region}</label>
          <select id="region" name="region" defaultValue={region?.slug}>
            {regions.map((r) => (
              <option key={r.slug} value={r.slug}>
                {r.name} ({r.hospital_count})
              </option>
            ))}
          </select>
          <button type="submit" className="button button-secondary">
            {t.common.update}
          </button>
        </form>
      )}
      <ul className="card-list">
        {hospitals.map((h) => (
          <li key={h.slug} className="card">
            <h2 className="h3">
              <Link href={`/${locale}/hospitals/${h.slug}`}>{h.name}</Link>
            </h2>
            <p>
              {h.city}
              {h.system_name ? ` · ${h.system_name}` : ""}
            </p>
            <p className="small muted">
              {h.last_updated_on ? fmt(t.common.lastUpdated, { date: h.last_updated_on }) : t.hospitals.noPrices}
            </p>
          </li>
        ))}
      </ul>
      {hospitals.length === 0 && <p role="status">{t.common.noData}</p>}
      <p className="small muted">
        <UnverifiedBadge text={t.common.notVerified} help={t.common.notVerifiedHelp} /> {t.common.notVerifiedHelp}
      </p>
    </>
  );
}
