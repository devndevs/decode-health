import Link from "next/link";
import { listHospitals, listServices } from "@decode-health/db";
import { DEFAULT_REGION } from "@/lib/content";
import { withDb } from "@/lib/db";
import { fmt, pick, resolveLocale } from "@/lib/i18n";

const POPULAR = ["office-visit-established", "mri-knee", "lipid-panel", "therapy-session", "vaginal-delivery", "emergency-room-visit"];

export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
  const { locale, t } = await resolveLocale(params);
  const [hospitals, services] = await Promise.all([
    withDb((pool) => listHospitals(pool, DEFAULT_REGION)),
    withDb((pool) => listServices(pool)),
  ]);
  const popular = POPULAR.flatMap((slug) => services?.filter((s) => s.slug === slug) ?? []);

  return (
    <>
      <section className="hero">
        <h1>{t.home.title}</h1>
        <p className="lead">{t.home.intro}</p>
        <form action={`/${locale}/services`} method="get" role="search" className="search">
          <label htmlFor="q">{t.common.searchServices}</label>
          <div className="search-row">
            <input id="q" name="q" type="search" placeholder={t.common.searchPlaceholder} autoComplete="off" />
            <button type="submit" className="button">
              {t.common.search}
            </button>
          </div>
        </form>
        <p className="cta-row">
          <Link className="button" href={`/${locale}/services`}>
            {t.home.ctaCompare}
          </Link>
          <Link className="button button-secondary" href={`/${locale}/help`}>
            {t.home.ctaHelp}
          </Link>
        </p>
      </section>

      {popular.length > 0 && (
        <section aria-labelledby="popular">
          <h2 id="popular">{t.home.popular}</h2>
          <ul className="chip-list">
            {popular.map((s) => (
              <li key={s.slug}>
                <Link href={`/${locale}/services/${s.slug}`} className="chip">
                  {pick(s.name, locale)}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="how">
        <h2 id="how">{t.home.howTitle}</h2>
        <ol className="steps">
          <li>{t.home.how1}</li>
          <li>{t.home.how2}</li>
          <li>{t.home.how3}</li>
        </ol>
      </section>

      <section aria-labelledby="coverage">
        <h2 id="coverage">{t.home.coverageTitle}</h2>
        <p>{t.home.coverageBody}</p>
        {hospitals?.length ? (
          <ul>
            {hospitals.map((h) => (
              <li key={h.slug}>
                <Link href={`/${locale}/hospitals/${h.slug}`}>{h.name}</Link>
                {h.last_updated_on ? (
                  <span className="muted small"> — {fmt(t.common.lastUpdated, { date: h.last_updated_on })}</span>
                ) : (
                  <span className="muted small"> — {t.hospitals.noPrices}</span>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </>
  );
}
