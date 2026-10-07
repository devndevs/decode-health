import Link from "next/link";
import { notFound } from "next/navigation";
import { formatUSDRange } from "@decode-health/core/money";
import { getService, listActiveRegions } from "@decode-health/db";
import { DEFAULT_REGION } from "@/lib/content";
import { withDb } from "@/lib/db";
import { fmt, pick, resolveLocale } from "@/lib/i18n";
import { compareAcrossHospitals } from "@/lib/pricing";

type Props = { params: Promise<{ locale: string; slug: string }>; searchParams: Promise<{ region?: string }> };

export async function generateMetadata({ params }: Props) {
  const { locale } = await resolveLocale(params);
  const { slug } = await params;
  const service = await withDb((pool) => getService(pool, slug));
  return { title: service ? pick(service.name, locale) : undefined };
}

export default async function ServicePage({ params, searchParams }: Props) {
  const { locale, t } = await resolveLocale(params);
  const { slug } = await params;
  const requested = (await searchParams).region;

  const data = await withDb(async (pool) => {
    const service = await getService(pool, slug);
    if (!service) return { service: null };
    const regions = await listActiveRegions(pool);
    const region = regions.find((r) => r.slug === requested) ?? regions.find((r) => r.slug === DEFAULT_REGION) ?? regions[0];
    const rows = region ? await compareAcrossHospitals(pool, service, region.slug, locale) : [];
    return { service, regions, region, rows };
  });

  if (data == null) return <p role="status">{t.common.dataUnavailable}</p>;
  if (!data.service) notFound();
  const { service, regions, region, rows } = data;
  const name = pick(service.name, locale);

  return (
    <>
      <p className="breadcrumb">
        <Link href={`/${locale}/services`}>{t.services.title}</Link> / {t.categories[service.category as keyof typeof t.categories]}
      </p>
      <h1>{name}</h1>
      <p className="lead">{pick(service.summary, locale)}</p>
      {service.aca_preventive && <p className="callout">{t.services.preventiveNote}</p>}

      <h2>{t.services.includes}</h2>
      <ul>
        {service.components.map((c) => (
          <li key={`${c.code_type}:${c.code}`}>
            {pick(c.label, locale)} <span className="muted small">({c.code_type} {c.code})</span>
          </li>
        ))}
      </ul>

      {regions && regions.length > 1 && (
        <form method="get" className="inline-form">
          <label htmlFor="region">{t.common.region}</label>
          <select id="region" name="region" defaultValue={region?.slug}>
            {regions.map((r) => (
              <option key={r.slug} value={r.slug}>
                {r.name}
              </option>
            ))}
          </select>
          <button type="submit" className="button button-secondary">
            {t.common.update}
          </button>
        </form>
      )}

      <h2>{fmt(t.services.compareTitle, { region: region?.name ?? "" })}</h2>
      {rows?.length ? (
        <div className="table-wrap">
          <table className="table">
            <caption>{fmt(t.services.compareCaption, { service: name })}</caption>
            <thead>
              <tr>
                <th scope="col">{t.common.hospital}</th>
                <th scope="col">{t.common.cashPrice}</th>
                <th scope="col">{t.common.typicalInsured}</th>
                <th scope="col">
                  <span className="visually-hidden">{t.common.estimateMyCost}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.hospital.slug}>
                  <th scope="row">
                    <Link href={`/${locale}/hospitals/${r.hospital.slug}`}>{r.hospital.name}</Link>
                    {r.partial && <p className="small muted">{t.services.missingParts}</p>}
                  </th>
                  <td>{r.cash ? formatUSDRange(r.cash.low, r.cash.high, locale) : "—"}</td>
                  <td>{r.insured ? formatUSDRange(r.insured.low, r.insured.high, locale) : "—"}</td>
                  <td>
                    <Link href={`/${locale}/estimate?hospital=${r.hospital.slug}&service=${service.slug}`}>{t.common.estimateMyCost}</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p role="status">{t.services.noHospitals}</p>
      )}
    </>
  );
}
