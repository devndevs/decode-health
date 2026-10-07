"use client";

/** Quick eligibility check. Runs in the browser; answers are never sent anywhere. */
import { useId, useState } from "react";
import { screenPrograms, type ScreenerResult } from "@decode-health/core/assistance";
import type { PovertyGuideline, Program } from "@decode-health/core";

export interface ScreenerStrings {
  screenerTitle: string;
  householdSize: string;
  householdHint: string;
  income: string;
  age: string;
  pregnant: string;
  insuredQ: string;
  yes: string;
  no: string;
  check: string;
  fplResult: string;
  matchesTitle: string;
  maybe: string;
  noMatches: string;
  disclaimer: string;
  visit: string;
}

function fill(template: string, vars: Record<string, string | number>) {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

export function HelpScreener(props: {
  locale: string;
  programs: Program[];
  guideline: PovertyGuideline;
  regionPath: string;
  t: ScreenerStrings;
}) {
  const { t, locale } = props;
  const id = useId();
  const [household, setHousehold] = useState("1");
  const [income, setIncome] = useState("");
  const [age, setAge] = useState("");
  const [pregnant, setPregnant] = useState<"" | "yes" | "no">("");
  const [insured, setInsured] = useState<"yes" | "no">("no");
  const [result, setResult] = useState<ScreenerResult | null>(null);

  const name = (p: Program) => (locale === "es" && p.name.es) || p.name.en;
  const f = (n: string) => `${id}-${n}`;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const incomeNum = Number(income.replace(/[$,\s]/g, ""));
    if (!Number.isFinite(incomeNum)) return;
    setResult(
      screenPrograms(
        props.programs,
        {
          householdSize: Math.max(1, Number(household) || 1),
          annualIncome: incomeNum,
          age: age.trim() ? Number(age) : undefined,
          pregnant: pregnant === "" ? undefined : pregnant === "yes",
          insured: insured === "yes",
          regionPath: props.regionPath,
        },
        props.guideline,
      ),
    );
  }

  return (
    <section className="card" aria-labelledby={f("title")}>
      <h2 id={f("title")}>{t.screenerTitle}</h2>
      <form onSubmit={onSubmit} className="screener">
        <div className="field">
          <label htmlFor={f("hh")}>{t.householdSize}</label>
          <input id={f("hh")} inputMode="numeric" value={household} onChange={(e) => setHousehold(e.target.value)} aria-describedby={f("hh-hint")} required />
          <p id={f("hh-hint")} className="hint">{t.householdHint}</p>
        </div>
        <div className="field">
          <label htmlFor={f("inc")}>{t.income}</label>
          <input id={f("inc")} inputMode="decimal" autoComplete="off" placeholder="$" value={income} onChange={(e) => setIncome(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor={f("age")}>{t.age}</label>
          <input id={f("age")} inputMode="numeric" autoComplete="off" value={age} onChange={(e) => setAge(e.target.value)} />
        </div>
        <fieldset className="field">
          <legend>{t.pregnant}</legend>
          {(["yes", "no"] as const).map((v) => (
            <div className="radio-row" key={v}>
              <input id={f(`preg-${v}`)} type="radio" name={f("preg")} checked={pregnant === v} onChange={() => setPregnant(v)} />
              <label htmlFor={f(`preg-${v}`)}>{t[v]}</label>
            </div>
          ))}
        </fieldset>
        <fieldset className="field">
          <legend>{t.insuredQ}</legend>
          {(["yes", "no"] as const).map((v) => (
            <div className="radio-row" key={v}>
              <input id={f(`ins-${v}`)} type="radio" name={f("ins")} checked={insured === v} onChange={() => setInsured(v)} />
              <label htmlFor={f(`ins-${v}`)}>{t[v]}</label>
            </div>
          ))}
        </fieldset>
        <button type="submit" className="button">{t.check}</button>
      </form>

      <div aria-live="polite">
        {result && (
          <div className="screener-result">
            <p>{fill(t.fplResult, { percent: result.fplPercent, year: result.guidelineYear })}</p>
            {result.matches.some((m) => m.program.eligibility) ? (
              <>
                <h3>{t.matchesTitle}</h3>
                <ul>
                  {result.matches
                    .filter((m) => m.program.eligibility)
                    .map((m) => (
                      <li key={m.program.slug}>
                        <a href={m.program.url} rel="noopener noreferrer" target="_blank">
                          {name(m.program)}
                        </a>
                        {!m.definite && <span className="muted small"> — {t.maybe}</span>}
                      </li>
                    ))}
                </ul>
              </>
            ) : (
              <p>{t.noMatches}</p>
            )}
            <p className="hint">{t.disclaimer}</p>
          </div>
        )}
      </div>
    </section>
  );
}
