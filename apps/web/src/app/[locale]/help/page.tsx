import { HelpScreener } from "@/components/HelpScreener";
import { UnverifiedBadge } from "@/components/Badges";
import { programs, povertyGuideline } from "@/lib/content";
import { fmt, pick, resolveLocale } from "@/lib/i18n";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props) {
  const { t } = await resolveLocale(params);
  return { title: t.help.title };
}

const KIND_ORDER = ["coverage", "discount", "clinic", "rights", "hotline"] as const;

export default async function HelpPage({ params }: Props) {
  const { locale, t } = await resolveLocale(params);
  // Until region selection is added here, screen against San Diego County.
  const regionPath = "ca/ca-socal/ca-san-diego-county";

  return (
    <>
      <h1>{t.help.title}</h1>
      <p className="lead">{t.help.intro}</p>

      <HelpScreener locale={locale} programs={programs} guideline={povertyGuideline} regionPath={regionPath} t={t.help} />

      <h2>{t.help.allTitle}</h2>
      {KIND_ORDER.map((kind) => {
        const list = programs.filter((p) => p.kind === kind);
        if (!list.length) return null;
        return (
          <section key={kind} aria-labelledby={`kind-${kind}`}>
            <h3 id={`kind-${kind}`}>{t.help.kinds[kind]}</h3>
            <ul className="card-list">
              {list.map((p) => (
                <li key={p.slug} className="card">
                  <h4>{pick(p.name, locale)}</h4>
                  {!p.verified && <UnverifiedBadge text={t.common.notVerified} help={t.common.notVerifiedHelp} />}
                  <p>{pick(p.summary, locale)}</p>
                  <p>
                    {p.phone && (
                      <>
                        <a href={`tel:${p.phone.replace(/[^0-9+]/g, "")}`}>{fmt(t.help.call, { phone: p.phone })}</a>
                        {" · "}
                      </>
                    )}
                    <a href={p.url} rel="noopener noreferrer">
                      {t.help.visit} <span className="visually-hidden">{t.common.externalLink}</span>
                    </a>
                  </p>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}
