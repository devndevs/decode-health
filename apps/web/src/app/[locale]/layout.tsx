import type { Metadata } from "next";
import Link from "next/link";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { NavLinks } from "@/components/NavLinks";
import { resolveLocale } from "@/lib/i18n";
import "../globals.css";

type Props = { children: React.ReactNode; params: Promise<{ locale: string }> };

// Every page is rendered per request: the strict CSP in src/proxy.ts uses a fresh
// nonce each time, and prices change whenever a hospital file is reloaded.
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: Omit<Props, "children">): Promise<Metadata> {
  const { t } = await resolveLocale(params);
  return {
    title: { default: `${t.meta.siteName} — ${t.meta.tagline}`, template: `%s · ${t.meta.siteName}` },
    description: t.meta.description,
    alternates: { languages: { en: "/en", es: "/es" } },
  };
}

export default async function LocaleLayout({ children, params }: Props) {
  const { locale, t } = await resolveLocale(params);
  const other = locale === "en" ? "es" : "en";
  return (
    <html lang={locale}>
      <body>
        <a href="#main" className="skip-link">
          {t.nav.skip}
        </a>
        <header className="site-header">
          <div className="container header-inner">
            <Link href={`/${locale}`} className="brand">
              {t.meta.siteName}
            </Link>
            <NavLinks
              label={t.nav.label}
              links={[
                { href: `/${locale}/services`, text: t.nav.services },
                { href: `/${locale}/estimate`, text: t.nav.estimate },
                { href: `/${locale}/hospitals`, text: t.nav.hospitals },
                { href: `/${locale}/help`, text: t.nav.help },
                { href: `/${locale}/about`, text: t.nav.about },
              ]}
            />
            <LanguageSwitcher target={other} text={t.nav.switchLanguage} label={t.nav.switchLanguageLabel} />
          </div>
        </header>
        <main id="main" tabIndex={-1} className="container">
          {children}
        </main>
        <footer className="site-footer">
          <div className="container">
            <p>
              <strong>{t.footer.emergency}</strong>
            </p>
            <p>{t.footer.disclaimer}</p>
            <p className="small">{t.footer.cpt}</p>
          </div>
        </footer>
      </body>
    </html>
  );
}
