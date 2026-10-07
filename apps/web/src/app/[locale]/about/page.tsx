import { resolveLocale } from "@/lib/i18n";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props) {
  const { t } = await resolveLocale(params);
  return { title: t.about.title };
}

export default async function AboutPage({ params }: Props) {
  const { t } = await resolveLocale(params);
  const sections = [
    [t.about.sourcesTitle, t.about.sourcesBody],
    [t.about.estimatesTitle, t.about.estimatesBody],
    [t.about.limitsTitle, t.about.limitsBody],
    [t.about.privacyTitle, t.about.privacyBody],
    [t.about.accessibilityTitle, t.about.accessibilityBody],
  ] as const;
  return (
    <>
      <h1>{t.about.title}</h1>
      {sections.map(([title, body]) => (
        <section key={title}>
          <h2>{title}</h2>
          <p>{body}</p>
        </section>
      ))}
    </>
  );
}
