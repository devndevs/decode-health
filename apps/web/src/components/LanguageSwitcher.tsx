"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Links to the same page in the other language. */
export function LanguageSwitcher({ target, text, label }: { target: "en" | "es"; text: string; label: string }) {
  const pathname = usePathname();
  const href = pathname.replace(/^\/(en|es)(?=\/|$)/, `/${target}`);
  return (
    <Link href={href} hrefLang={target} lang={target} aria-label={label} className="lang-switch">
      {text}
    </Link>
  );
}
