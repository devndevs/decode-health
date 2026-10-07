import { PRODUCT_TYPES, type ProductType } from "@decode-health/core";
import { componentPricing, getService, listHospitals, listPayers, listServices } from "@decode-health/db";
import { EstimateCalculator } from "@/components/EstimateCalculator";
import { DEFAULT_REGION } from "@/lib/content";
import { withDb } from "@/lib/db";
import { pick, resolveLocale } from "@/lib/i18n";
import { componentSpecs } from "@/lib/pricing";

type Search = { hospital?: string; service?: string; coverage?: string; payer?: string; product?: string };
type Props = { params: Promise<{ locale: string }>; searchParams: Promise<Search> };

export async function generateMetadata({ params }: Props) {
  const { t } = await resolveLocale(params);
  return { title: t.estimate.title };
}

const slugish = (v: string | undefined) => (v && /^[a-z0-9-]{1,80}$/.test(v) ? v : undefined);

export default async function EstimatePage({ params, searchParams }: Props) {
  const { locale, t } = await resolveLocale(params);
  const q = await searchParams;
  const coverage = q.coverage === "uninsured" ? "uninsured" : "insured";
  const productType = (PRODUCT_TYPES as readonly string[]).includes(q.product ?? "") ? (q.product as ProductType) : null;

  const data = await withDb(async (pool) => {
    const [hospitals, services, payers] = await Promise.all([
      listHospitals(pool, DEFAULT_REGION).then((hs) => hs.filter((h) => h.has_prices)),
      listServices(pool),
      listPayers(pool),
    ]);
    const hospital = hospitals.find((h) => h.slug === slugish(q.hospital));
    const service = slugish(q.service) ? await getService(pool, q.service!) : null;
    const payer = payers.find((p) => p.slug === slugish(q.payer)) ?? null;
    const pricing =
      hospital && service
        ? (
            await componentPricing(pool, {
              hospitalIds: [hospital.id],
              components: componentSpecs(service.components, locale),
              setting: service.setting,
              payerSlug: coverage === "insured" ? payer?.slug : null,
              productType: coverage === "insured" ? productType : null,
            })
          ).get(hospital.id)
        : undefined;
    return { hospitals, services, payers, hospital, service, payer, pricing };
  });

  if (data == null) return <p role="status">{t.common.dataUnavailable}</p>;
  const { hospitals, services, payers, hospital, service, payer, pricing } = data;
  const products = payer?.products.length ? payer.products : PRODUCT_TYPES.filter((p) => p !== "all");

  return (
    <>
      <h1>{t.estimate.title}</h1>
      <p className="lead">{t.estimate.intro}</p>

      <form method="get" className="card estimate-form">
        <div className="field">
          <label htmlFor="hospital">{t.estimate.chooseHospital}</label>
          <select id="hospital" name="hospital" defaultValue={hospital?.slug ?? ""} required>
            <option value="" disabled>
              —
            </option>
            {hospitals.map((h) => (
              <option key={h.slug} value={h.slug}>
                {h.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="service">{t.estimate.chooseService}</label>
          <select id="service" name="service" defaultValue={service?.slug ?? ""} required>
            <option value="" disabled>
              —
            </option>
            {services.map((s) => (
              <option key={s.slug} value={s.slug}>
                {pick(s.name, locale)}
              </option>
            ))}
          </select>
        </div>
        <fieldset className="field">
          <legend>{t.estimate.coverage}</legend>
          <div className="radio-row">
            <input id="cov-insured" type="radio" name="coverage" value="insured" defaultChecked={coverage === "insured"} />
            <label htmlFor="cov-insured">{t.estimate.insured}</label>
          </div>
          <div className="radio-row">
            <input id="cov-uninsured" type="radio" name="coverage" value="uninsured" defaultChecked={coverage === "uninsured"} />
            <label htmlFor="cov-uninsured">{t.estimate.uninsured}</label>
          </div>
        </fieldset>
        <div className="field">
          <label htmlFor="payer">{t.estimate.payer}</label>
          <select id="payer" name="payer" defaultValue={payer?.slug ?? ""}>
            <option value="">{t.estimate.payerPlaceholder}</option>
            {payers.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="product">{t.estimate.product}</label>
          <select id="product" name="product" defaultValue={productType ?? ""} aria-describedby="product-hint">
            <option value="">—</option>
            {products.map((p) => (
              <option key={p} value={p}>
                {t.products[p as keyof typeof t.products]}
              </option>
            ))}
            <option value="other">{t.products.other}</option>
          </select>
          <p id="product-hint" className="hint">
            {t.estimate.productHint}
          </p>
        </div>
        <button type="submit" className="button">
          {t.estimate.showPrices}
        </button>
      </form>

      {service && hospital && pricing && (
        <section aria-label={`${pick(service.name, locale)} — ${hospital.name}`}>
          <h2 className="h3">
            {pick(service.name, locale)} · {hospital.name}
          </h2>
          <EstimateCalculator
            locale={locale}
            coverage={coverage}
            acaPreventive={service.aca_preventive}
            components={pricing}
            t={t.estimate}
          />
        </section>
      )}
    </>
  );
}
