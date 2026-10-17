import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { formatUsdc } from "@backstop/core/money";
import { TimeAgo } from "@/components/client";
import { EmptyState, PageHeader, Panel, SkeletonRows } from "@/components/ui";
import { DISPUTE_REASONS, type DisputeReason } from "@backstop/core/state";
import { listOpenDisputes } from "@/server/disputes";
import { pageSession } from "@/server/page-session";

export const metadata: Metadata = { title: "Disputes", robots: { index: false } };

async function Queue() {
  const session = await pageSession();
  if (!session) redirect("/signin?next=/admin");
  if (!session.isAdmin) notFound();
  const rows = await listOpenDisputes();
  if (rows.length === 0) return <EmptyState title="No open disputes">New disputes appear here as soon as a payer files one.</EmptyState>;
  return (
    <ul className="divide-y divide-line">
      {rows.map((r) => {
        const overdue = r.dispute.respondBy < new Date();
        return (
          <li key={r.dispute.id}>
            <Link href={`/p/${r.escrow.id}`} className="grid gap-1 px-5 py-4 hover:bg-sunken sm:grid-cols-[1fr_auto] sm:items-center">
              <div className="min-w-0">
                <p className="text-ink">{r.serviceName} · <span className="tabular">{formatUsdc(r.escrow.amountAtomic)}</span> USDC</p>
                <p className="text-sm text-ink-3">{DISPUTE_REASONS[r.dispute.reason as DisputeReason] ?? r.dispute.reason} · filed <TimeAgo value={r.dispute.createdAt} /></p>
              </div>
              <p className={overdue ? "text-sm text-failed" : r.dispute.providerRespondedAt ? "text-sm text-released" : "text-sm text-held"}>
                {r.dispute.providerRespondedAt ? "Provider answered, ready to decide" : overdue ? "Provider missed the deadline" : "Waiting for provider"}
              </p>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export default function AdminPage() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
      <PageHeader title="Open disputes" description="Oldest deadline first. Unanswered disputes refund automatically when their deadline passes." />
      <Panel>
        <Suspense fallback={<SkeletonRows rows={5} />}>
          <Queue />
        </Suspense>
      </Panel>
    </div>
  );
}
