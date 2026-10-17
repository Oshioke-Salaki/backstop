import Link from "next/link";
import { Suspense } from "react";
import { pageSession } from "@/server/page-session";
import { Logo } from "./brand";
import { SignOutButton } from "./sign-in";
import { buttonClass, shortHex, Skeleton } from "./ui";

const NAV = [
  { href: "/services", label: "Services" },
  { href: "/docs", label: "Docs" },
  { href: "/verify", label: "Verify a receipt" },
];

async function Account() {
  const session = await pageSession();
  if (!session) {
    return (
      <Link href="/signin" className={buttonClass("secondary", "sm")}>
        Sign in
      </Link>
    );
  }
  return (
    <div className="flex items-center gap-1">
      {session.isAdmin && (
        <Link href="/admin" className={buttonClass("ghost", "sm")}>
          Disputes
        </Link>
      )}
      <Link href="/dashboard" className={buttonClass("ghost", "sm")}>
        Dashboard
      </Link>
      <span className="hidden px-2 font-mono text-xs text-ink-3 md:inline" title={session.address}>
        {shortHex(session.address)}
      </span>
      <SignOutButton />
    </div>
  );
}

export function SiteHeader() {
  return (
    <header className="border-b border-line bg-ground">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex items-center gap-8">
          <Logo />
          <nav aria-label="Main" className="hidden items-center gap-6 md:flex">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} className="text-[15px] text-ink-2 transition-colors hover:text-ink">
                {n.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-2">
          <Suspense fallback={<Skeleton className="h-8 w-20" />}>
            <Account />
          </Suspense>
          <details className="relative md:hidden">
            <summary className={buttonClass("ghost", "sm", "list-none [&::-webkit-details-marker]:hidden")} aria-label="Menu">
              Menu
            </summary>
            <nav aria-label="Mobile" className="absolute right-0 z-20 mt-2 flex w-52 flex-col rounded-md border border-line bg-surface p-1">
              {NAV.map((n) => (
                <Link key={n.href} href={n.href} className="rounded-sm px-3 py-2 text-[15px] text-ink-2 hover:bg-sunken hover:text-ink">
                  {n.label}
                </Link>
              ))}
            </nav>
          </details>
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t border-line">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:grid-cols-[1.4fr_1fr_1fr_1fr] sm:px-6">
        <div className="flex flex-col gap-3">
          <Logo />
          <p className="max-w-xs text-sm text-ink-3">Escrow and automatic refunds for agent payments. Built for PayBox and any x402 client.</p>
        </div>
        <FooterCol title="Product" links={[["Services", "/services"], ["Verify a receipt", "/verify"], ["Provider dashboard", "/dashboard"]]} />
        <FooterCol title="Developers" links={[["Agent guide", "/docs/agents"], ["Provider guide", "/docs/providers"], ["API reference", "/docs/api"]]} />
        <FooterCol title="Trust" links={[["How funds are protected", "/docs/security"], ["Disputes", "/docs/disputes"], ["Status", "/api/health"]]} />
      </div>
    </footer>
  );
}

function FooterCol({ title, links }: { title: string; links: Array<[string, string]> }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium text-ink">{title}</p>
      {links.map(([label, href]) => (
        <Link key={href} href={href} className="text-sm text-ink-3 hover:text-ink">
          {label}
        </Link>
      ))}
    </div>
  );
}
