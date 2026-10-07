import Link from "next/link";
import { SERVICE_CATEGORIES } from "@decode-health/core";
import { listServices } from "@decode-health/db";
import { withDb } from "@/lib/db";
import { fmt, pick, resolveLocale } from "@/lib/i18n";

type Props = { params: Promise<{ locale: string }>; searchParams: Promise<{ q?: string }> };

export async function generateMetadata({ params }: Props) {
  const { t } = await resolveLocale(params);
  return { title: t.services.title };
}

export default async function ServicesPage({ params, searchParams }: Props) {
  const { locale, t } = await resolveLocale(params);
  const q = (await searchParams).q?.slice(0, 100) ?? "";
  const services = await withDb((pool) => listServices(pool, { q }));

  return (
    <>
      <h1>{t.services.title}</h1>
      <p className="lead">{t.services.intro}</p>
      <form method="get" role="search" className="search">
        <label htmlFor="q">{t.common.searchServices}</label>
        <div className="search-row">
          <input id="q" name="q" type="search" defaultValue={q} placeholder={t.common.searchPlaceholder} autoComplete="off" />
          <button type="submit" className="button">
            {t.common.search}
          </button>
        </div>
      </form>

      {services == null ? (
        <p role="status">{t.common.dataUnavailable}</p>
      ) : services.length === 0 ? (
        <p role="status">{t.services.noMatches}</p>
      ) : (
        <>
          {q && <p role="status">{fmt(t.common.results, { count: services.length })}</p>}
          {SERVICE_CATEGORIES.map((cat) => {
            const inCat = services.filter((s) => s.category === cat);
            if (!inCat.length) return null;
            return (
              <section key={cat} aria-labelledby={`cat-${cat}`}>
                <h2 id={`cat-${cat}`}>{t.categories[cat]}</h2>
                <ul className="card-list">
                  {inCat.map((s) => (
                    <li key={s.slug} className="card">
                      <h3>
                        <Link href={`/${locale}/services/${s.slug}`}>{pick(s.name, locale)}</Link>
                      </h3>
                      <p>{pick(s.summary, locale)}</p>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </>
      )}
    </>
  );
}
