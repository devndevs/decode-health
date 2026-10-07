"use client";

/**
 * Applies the person's benefits to server-provided prices, entirely in the
 * browser. Plan details are never sent to the server or stored.
 */
import { useId, useMemo, useState } from "react";
import { estimateCost, type BenefitInputs, type ComponentPricing } from "@decode-health/core/estimator";
import { formatUSD, formatUSDRange } from "@decode-health/core/money";
import { ConfidenceBadge } from "./Badges";

export interface EstimateStrings {
  benefitsTitle: string;
  benefitsIntro: string;
  deductibleRemaining: string;
  deductibleAppliesLabel: string;
  deductibleAppliesHint: string;
  costShareType: string;
  coinsurance: string;
  copay: string;
  coinsurancePercent: string;
  copayAmount: string;
  oopRemaining: string;
  resultTitle: string;
  youPay: string;
  totalPrice: string;
  typical: string;
  range: string;
  breakdown: string;
  noPriceForPart: string;
  noEstimate: string;
  privacy: string;
  deductibleUnknown: string;
  basis: Record<string, string>;
  confidence: { label: string; high: string; medium: string; low: string };
  notes: Record<string, string>;
}

/** "$1,500" → 1500. Blank or invalid → null. */
function money(input: string): number | null {
  const n = Number(input.replace(/[$,\s%]/g, ""));
  return input.trim() && Number.isFinite(n) && n >= 0 ? n : null;
}

export function EstimateCalculator(props: {
  locale: string;
  coverage: "insured" | "uninsured";
  acaPreventive: boolean;
  components: ComponentPricing[];
  t: EstimateStrings;
}) {
  const { locale, t } = props;
  const id = useId();
  const [deductible, setDeductible] = useState("");
  const [deductibleApplies, setDeductibleApplies] = useState(true);
  const [shareType, setShareType] = useState<"coinsurance" | "copay">("coinsurance");
  const [coinsurance, setCoinsurance] = useState("20");
  const [copay, setCopay] = useState("");
  const [oop, setOop] = useState("");

  const { result, worstCase } = useMemo(() => {
    if (props.coverage === "uninsured") {
      return { result: estimateCost({ components: props.components, coverage: { kind: "uninsured" } }), worstCase: null };
    }
    const run = (deductibleRemaining: number) => {
      const benefits: BenefitInputs = {
        deductibleRemaining,
        deductibleApplies,
        afterDeductible:
          shareType === "copay"
            ? { type: "copay", amount: money(copay) ?? 0 }
            : { type: "coinsurance", percent: money(coinsurance) ?? 20 },
        oopMaxRemaining: money(oop),
      };
      return estimateCost({ components: props.components, coverage: { kind: "insured", benefits }, acaPreventive: props.acaPreventive });
    };
    const known = money(deductible);
    // Deductible left blank: show the "already met" estimate, plus what it could be if none of it is met yet.
    const unknown = known == null && deductibleApplies && !props.acaPreventive;
    return { result: run(known ?? 0), worstCase: unknown ? run(Number.POSITIVE_INFINITY).patient : null };
  }, [props, deductible, deductibleApplies, shareType, coinsurance, copay, oop]);

  const field = (name: string) => `${id}-${name}`;

  return (
    <div className="estimate-grid">
      {props.coverage === "insured" && (
        <form className="card" onSubmit={(e) => e.preventDefault()} aria-labelledby={field("benefits")}>
          <h2 id={field("benefits")}>{t.benefitsTitle}</h2>
          <p className="muted">{t.benefitsIntro}</p>

          <div className="field">
            <label htmlFor={field("ded")}>{t.deductibleRemaining}</label>
            <input id={field("ded")} inputMode="decimal" autoComplete="off" placeholder="$0" value={deductible} onChange={(e) => setDeductible(e.target.value)} />
          </div>

          <div className="field field-check">
            <input id={field("applies")} type="checkbox" checked={deductibleApplies} onChange={(e) => setDeductibleApplies(e.target.checked)} aria-describedby={field("applies-hint")} />
            <label htmlFor={field("applies")}>{t.deductibleAppliesLabel}</label>
            <p id={field("applies-hint")} className="hint">{t.deductibleAppliesHint}</p>
          </div>

          <fieldset className="field">
            <legend>{t.costShareType}</legend>
            <div className="radio-row">
              <input id={field("coins")} type="radio" name={field("share")} checked={shareType === "coinsurance"} onChange={() => setShareType("coinsurance")} />
              <label htmlFor={field("coins")}>{t.coinsurance}</label>
            </div>
            <div className="radio-row">
              <input id={field("copay")} type="radio" name={field("share")} checked={shareType === "copay"} onChange={() => setShareType("copay")} />
              <label htmlFor={field("copay")}>{t.copay}</label>
            </div>
          </fieldset>

          {shareType === "coinsurance" ? (
            <div className="field">
              <label htmlFor={field("pct")}>{t.coinsurancePercent}</label>
              <input id={field("pct")} inputMode="decimal" autoComplete="off" value={coinsurance} onChange={(e) => setCoinsurance(e.target.value)} />
            </div>
          ) : (
            <div className="field">
              <label htmlFor={field("copay-amt")}>{t.copayAmount}</label>
              <input id={field("copay-amt")} inputMode="decimal" autoComplete="off" placeholder="$0" value={copay} onChange={(e) => setCopay(e.target.value)} />
            </div>
          )}

          <div className="field">
            <label htmlFor={field("oop")}>{t.oopRemaining}</label>
            <input id={field("oop")} inputMode="decimal" autoComplete="off" value={oop} onChange={(e) => setOop(e.target.value)} />
          </div>
          <p className="hint">{t.privacy}</p>
        </form>
      )}

      <section className="card result" aria-labelledby={field("result")}>
        <h2 id={field("result")}>{t.resultTitle}</h2>
        <div aria-live="polite" aria-atomic="true">
          {result.patient && result.allowed ? (
            <>
              <p className="big-number">
                <span className="label">{t.youPay}</span>
                <strong>{formatUSD(result.patient.typical, locale)}</strong>
                {Math.round(result.patient.low) !== Math.round(result.patient.high) && (
                  <span className="muted">
                    {" "}
                    ({t.range}: {formatUSDRange(result.patient.low, result.patient.high, locale)})
                  </span>
                )}
              </p>
              {worstCase && worstCase.high > result.patient.high && (
                <p>{t.deductibleUnknown.replace("{amount}", formatUSD(worstCase.high, locale))}</p>
              )}
              {props.coverage === "insured" && (
                <p>
                  {t.totalPrice}: {formatUSDRange(result.allowed.low, result.allowed.high, locale)}
                </p>
              )}
              <p>
                <ConfidenceBadge level={result.confidence} label={t.confidence.label} text={t.confidence[result.confidence]} />
              </p>
            </>
          ) : (
            <p>{t.noEstimate}</p>
          )}
          {result.notes.length > 0 && (
            <ul className="notes">
              {result.notes.map((n) => (
                <li key={n}>{t.notes[n] ?? n}</li>
              ))}
            </ul>
          )}
        </div>

        <h3>{t.breakdown}</h3>
        <table className="table compact">
          <tbody>
            {result.components.map((c) => (
              <tr key={c.key}>
                <th scope="row">{c.label ?? c.key}</th>
                <td>
                  {c.basis ? (
                    <>
                      {formatUSDRange(c.basis.low, c.basis.high, locale)}
                      <span className="muted small"> · {t.basis[c.basis.source]}</span>
                    </>
                  ) : (
                    <span className="muted">{t.noPriceForPart}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
