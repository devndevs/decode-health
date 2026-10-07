import Link from "next/link";
import { notFound } from "next/navigation";
import { formatUSDRange } from "@decode-health/core/money";
import { getHospital, listServicesWithComponents } from "@decode-health/db";
import { UnverifiedBadge } from "@/components/Badges";
import { withDb } from "@/lib/db";
import { fmt, pick, resolveLocale } from "@/lib/i18n";
import { cashPricesAtHospital } from "@/lib/pricing";

type Props = { params: Promise<{ locale: string; slug: string }> };

export async function generateMetadata({ params }: Props) {
  const { slug } = await params;
  const h = await withDb((pool) => getHospital(pool, slug));
  return { title: h?.name };
}

export default async function HospitalPage({ params }: Props) {
  const { locale, t } = await resolveLocale(params);
  const { slug } = await params;

  const data = await withDb(async (pool) => {
    const hospital = await getHospital(pool, slug);
    if (!hospital) return { hospital: null };
    const services = await listServicesWithComponents(pool);
    const prices = hospital.has_prices ? await cashPricesAtHospital(pool, hospital.id, services, locale) : new Map();
    return { hospital, services, prices };
  });

  if (data == null) return <p role="status">{t.common.dataUnavailable}</p>;
  if (!data.hospital) notFound();
  const { hospital: h, services, prices } = data;

  return (
    <>
      <p className="breadcrumb">
        <Link href={`/${locale}/hospitals`}>{t.hospitals.title}</Link>
      </p>
      <h1>{h.name}</h1>
      {!h.verified && <UnverifiedBadge text={t.common.notVerified} help={t.common.notVerifiedHelp} />}
      <dl className="facts">
        <dt>{t.hospitals.address}</dt>
        <dd>
          {h.address_line1}, {h.city}, {h.state} {h.zip}
        </dd>
        <dt>{t.hospitals.website}</dt>
        <dd>
          <a href={h.website} rel="noopener noreferrer">
            {new URL(h.website).hostname}
          </a>
        </dd>
        {h.source_page_url && (
          <>
            <dt>{t.hospitals.sourceFile}</dt>
            <dd>
              <a href={h.source_page_url} rel="noopener noreferrer">
                {new URL(h.source_page_url).hostname} <span className="visually-hidden">{t.common.externalLink}</span>
              </a>
            </dd>
          </>
        )}
        <dt>{t.hospitals.financialAssistance}</dt>
        <dd>
          {h.financial_assistance_url ? (
            <a href={h.financial_assistance_url} rel="noopener noreferrer">
              {t.common.learnMore}
            </a>
          ) : (
            t.hospitals.financialAssistanceMissing
          )}
        </dd>
      </dl>
      <p className="small muted">{h.last_updated_on ? fmt(t.common.lastUpdated, { date: h.last_updated_on }) : t.hospitals.noPrices}</p>

      {h.has_prices && (
        <section aria-labelledby="prices">
          <h2 id="prices">{t.hospitals.pricesTitle}</h2>
          <p>{t.hospitals.pricesIntro}</p>
          <div className="table-wrap">
            <table className="table">
              <caption className="visually-hidden">{t.hospitals.pricesTitle}</caption>
              <thead>
                <tr>
                  <th scope="col">{t.common.service}</th>
                  <th scope="col">{t.common.cashPrice}</th>
                </tr>
              </thead>
              <tbody>
                {services
                  .filter((s) => prices.has(s.slug))
                  .map((s) => {
                    const r = prices.get(s.slug)!;
                    return (
                      <tr key={s.slug}>
                        <th scope="row">
                          <Link href={`/${locale}/estimate?hospital=${h.slug}&service=${s.slug}`}>{pick(s.name, locale)}</Link>
                        </th>
                        <td>{formatUSDRange(r.low, r.high, locale)}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
