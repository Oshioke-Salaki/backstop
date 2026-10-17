import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { EmptyState, inputClass, PageHeader, Panel, SkeletonRows, buttonClass } from "@/components/ui";
import { formatDuration, formatMs } from "@/lib/format";
import { listPublicServices } from "@/server/services";

export const metadata: Metadata = { title: "Protected services" };

async function Results({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await connection();
  const { q } = await searchParams;
  const query = q?.slice(0, 100).trim() || undefined;
  const services = await listPublicServices({ query });
  if (services.length === 0) {
    return query ? (
      <EmptyState title={`Nothing matches “${query}”`} action={<Link href="/services" className={buttonClass("secondary", "sm")}>Clear search</Link>}>
        Try a broader word, like the kind of data you need.
      </EmptyState>
    ) : (
      <EmptyState title="No services are listed yet" action={<Link href="/dashboard" className={buttonClass("primary", "sm")}>List the first one</Link>}>
        Providers appear here once their payout address is approved and they publish a service.
      </EmptyState>
    );
  }
  return (
    <ul className="divide-y divide-line">
      {services.map((s) => (
        <li key={s.id}>
          <Link href={`/services/${s.slug}`} className="grid gap-2 px-5 py-4 transition-colors hover:bg-sunken sm:grid-cols-[1fr_auto] sm:items-center sm:gap-6">
            <div className="min-w-0">
              <p className="font-medium text-ink">
                {s.name}
                {s.status === "paused" && <span className="ml-2 text-sm font-normal text-held">Paused</span>}
              </p>
              <p className="mt-0.5 line-clamp-2 text-[15px] text-ink-2">{s.description}</p>
              <p className="mt-1 text-sm text-ink-3">
                {s.provider.name} · answers within {formatMs(s.sla.maxLatencyMs)} · dispute window {formatDuration(s.disputeWindowSeconds)}
              </p>
            </div>
            <p className="tabular text-[15px] font-medium text-ink sm:text-right">
              {s.price} <span className="font-normal text-ink-3">USDC</span>
            </p>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default function ServicesPage(props: { searchParams: Promise<{ q?: string }> }) {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <PageHeader title="Protected services" description="Every call here is paid into escrow and refunded automatically if the provider fails its own checks." />
      <form action="/services" className="mb-6 flex gap-2" role="search">
        <label htmlFor="q" className="sr-only">Search services</label>
        <Suspense fallback={<input id="q" name="q" className={`${inputClass} h-10`} placeholder="Search by name or what it does" />}>
          <SearchInput searchParams={props.searchParams} />
        </Suspense>
        <button className={buttonClass("secondary")}>Search</button>
      </form>
      <Panel>
        <Suspense fallback={<SkeletonRows rows={5} />}>
          <Results searchParams={props.searchParams} />
        </Suspense>
      </Panel>
    </div>
  );
}

async function SearchInput({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  return <input id="q" name="q" defaultValue={q ?? ""} maxLength={100} className={`${inputClass} h-10`} placeholder="Search by name or what it does" />;
}
