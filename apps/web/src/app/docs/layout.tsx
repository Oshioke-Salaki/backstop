import Link from "next/link";

const PAGES = [
  ["/docs", "Overview"],
  ["/docs/agents", "For agents"],
  ["/docs/providers", "For providers"],
  ["/docs/disputes", "Disputes"],
  ["/docs/security", "How funds are protected"],
  ["/docs/api", "API reference"],
] as const;

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-[12rem_1fr]">
      <nav aria-label="Docs" className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
        {PAGES.map(([href, label]) => (
          <Link key={href} href={href} className="shrink-0 rounded-md px-3 py-1.5 text-[15px] text-ink-2 hover:bg-sunken hover:text-ink">
            {label}
          </Link>
        ))}
      </nav>
      <article className="docs min-w-0 max-w-3xl">{children}</article>
    </div>
  );
}
