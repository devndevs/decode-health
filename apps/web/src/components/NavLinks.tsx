"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function NavLinks({ label, links }: { label: string; links: Array<{ href: string; text: string }> }) {
  const pathname = usePathname();
  return (
    <nav aria-label={label}>
      <ul className="nav-list">
        {links.map((l) => {
          const current = pathname === l.href || pathname.startsWith(`${l.href}/`);
          return (
            <li key={l.href}>
              <Link href={l.href} aria-current={current ? "page" : undefined}>
                {l.text}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
