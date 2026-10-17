import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import type { EscrowStatus } from "@backstop/core/state";
import { PaymentsTable } from "@/components/payments-table";
import { buttonClass, cx, EmptyState, PageHeader, Panel, SkeletonRows } from "@/components/ui";
import { ApiError } from "@/server/http";
import { listPayments } from "@/server/payments";
import { pageSession } from "@/server/page-session";
import { getProviderForOwner } from "@/server/providers";

export const metadata: Metadata = { title: "Payments" };

const FILTERS: Array<{ key: string; label: string; statuses?: EscrowStatus[] }> = [
  { key: "all", label: "All" },
  { key: "held", label: "In escrow", statuses: ["held", "release_pending"] },
  { key: "disputed", label: "Disputed", statuses: ["disputed"] },
  { key: "paid", label: "Paid", statuses: ["released", "split"] },
  { key: "refunded", label: "Refunded", statuses: ["refund_pending", "refunded", "reclaimed"] },
];

type Props = { searchParams: Promise<{ filter?: string; cursor?: string; as?: string }> };

async function List({ searchParams }: Props) {
  const [{ filter = "all", cursor, as }, session] = await Promise.all([searchParams, pageSession()]);
  if (!session) redirect("/signin?next=/dashboard/payments");
  const provider = as === "payer" ? null : await getProviderForOwner(session.address);
  const asPayer = !provider;
  const active = FILTERS.find((f) => f.key === filter) ?? FILTERS[0]!;

  let page;
  try {
    page = await listPayments({ ...(asPayer ? { payer: session.address } : { providerId: provider!.id }), status: active.statuses, cursor: cursor ?? null });
  } catch (err) {
    if (err instanceof ApiError && err.code === "invalid_cursor") redirect(`/dashboard/payments?filter=${active.key}${as ? `&as=${as}` : ""}`);
    throw err;
  }
  const qs = (extra: Record<string, string>) => new URLSearchParams({ ...(active.key !== "all" ? { filter: active.key } : {}), ...(as ? { as } : {}), ...extra }).toString();

  return (
    <>
      <PageHeader
        title={asPayer ? "Payments you made" : "Payments to you"}
        back={{ href: "/dashboard", label: "Dashboard" }}
        action={
          provider ? (
            <Link href={`/dashboard/payments?as=payer`} className={buttonClass("ghost", "sm")}>Payments you made</Link>
          ) : as === "payer" ? (
            <Link href="/dashboard/payments" className={buttonClass("ghost", "sm")}>Payments to you</Link>
          ) : undefined
        }
      />
      <nav aria-label="Filter payments" className="mb-4 flex flex-wrap gap-1">
        {FILTERS.map((f) => (
          <Link key={f.key} href={`/dashboard/payments?${new URLSearchParams({ ...(f.key !== "all" ? { filter: f.key } : {}), ...(as ? { as } : {}) })}`} aria-current={f.key === active.key ? "page" : undefined} className={cx("rounded-md px-3 py-1.5 text-sm", f.key === active.key ? "bg-ink text-ground" : "text-ink-2 hover:bg-sunken")}>
            {f.label}
          </Link>
        ))}
      </nav>
      <Panel>
        {page.items.length === 0 ? (
          <EmptyState title={cursor ? "No more payments" : active.key === "all" ? "No payments yet" : `Nothing ${active.label.toLowerCase()}`}>
            {asPayer ? "Payments made from your wallet through Backstop appear here." : "Paid calls to your services appear here with their verdicts."}
          </EmptyState>
        ) : (
          <PaymentsTable items={page.items} showPayer={!asPayer} />
        )}
      </Panel>
      <div className="mt-4 flex justify-end gap-2">
        {cursor && <Link href={`/dashboard/payments?${qs({})}`} className={buttonClass("ghost", "sm")}>Back to newest</Link>}
        {page.nextCursor && <Link href={`/dashboard/payments?${qs({ cursor: page.nextCursor })}`} className={buttonClass("secondary", "sm")}>Older</Link>}
      </div>
    </>
  );
}

export default function PaymentsPage(props: Props) {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <Suspense fallback={<Panel><SkeletonRows rows={8} /></Panel>}>
        <List {...props} />
      </Suspense>
    </div>
  );
}
