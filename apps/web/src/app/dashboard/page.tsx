import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { ApiKeys, OnboardingForm, PayoutPending, ProfileForm, RotateSecret } from "@/components/provider-forms";
import { AutoRefresh } from "@/components/payment-actions";
import { LocalTime } from "@/components/client";
import { PaymentsTable } from "@/components/payments-table";
import { ButtonLink, EmptyState, PageHeader, Panel, PanelHeader, Skeleton, SkeletonRows, Stat, cx } from "@/components/ui";
import { formatPercent } from "@/lib/format";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { disputes, escrows, services as servicesTable } from "@/server/db/schema";
import { listPayments, scorecard } from "@/server/payments";
import { pageSession } from "@/server/page-session";
import { getProviderForOwner, listApiKeys } from "@/server/providers";
import { listProviderServices } from "@/server/services";

export const metadata: Metadata = { title: "Dashboard" };

async function Dashboard() {
  const session = await pageSession();
  if (!session) redirect("/signin?next=/dashboard");
  const provider = await getProviderForOwner(session.address);

  if (!provider) {
    const mine = await listPayments({ payer: session.address });
    return (
      <>
        <PageHeader title="Become a provider" description="List an API behind Backstop. Agents pay into escrow and you are paid automatically for every response that keeps your promise." />
        <div className="grid grid-cols-1 gap-10 lg:grid-cols-[1fr_22rem]">
          <Panel className="p-5 sm:p-6">
            <OnboardingForm address={session.address} />
          </Panel>
          <div className="flex flex-col gap-4 text-[15px] text-ink-2">
            <p className="font-medium text-ink">What happens next</p>
            <ol className="flex list-decimal flex-col gap-2 pl-5">
              <li>Your payout address is approved in the escrow contract, usually within a minute.</li>
              <li>You describe a service and what every response promises.</li>
              <li>You test it against your live API for free, then publish.</li>
            </ol>
          </div>
        </div>
        {mine.items.length > 0 && (
          <Panel className="mt-10">
            <PanelHeader title="Payments from your wallet" />
            <PaymentsTable items={mine.items} showPayer={false} />
          </Panel>
        )}
      </>
    );
  }

  const db = await getDb();
  const [svc, card, recent, keys, unanswered] = await Promise.all([
    listProviderServices(provider.id),
    scorecard({ providerId: provider.id }),
    listPayments({ providerId: provider.id }),
    listApiKeys(provider.id),
    db
      .select({ escrowId: disputes.escrowId, respondBy: disputes.respondBy, service: servicesTable.name })
      .from(disputes)
      .innerJoin(escrows, eq(disputes.escrowId, escrows.id))
      .innerJoin(servicesTable, eq(escrows.serviceId, servicesTable.id))
      .where(and(eq(servicesTable.providerId, provider.id), eq(disputes.status, "open"))),
  ]);

  return (
    <>
      <PageHeader
        title={provider.name}
        description={<>Paying out to <span className="font-mono text-[14px]">{provider.payoutAddress}</span></>}
        action={<ButtonLink href="/dashboard/services/new">New service</ButtonLink>}
      />

      <div className="flex flex-col gap-6">
        {!provider.payoutApproved && (
          <div className="flex flex-col gap-2">
            <PayoutPending />
            <AutoRefresh intervalMs={5000} />
          </div>
        )}

        {unanswered.length > 0 && (
          <Panel>
            <PanelHeader title={`${unanswered.length} open ${unanswered.length === 1 ? "dispute" : "disputes"}`} description="Answer before the deadline, or the payer is refunded automatically." />
            <ul className="divide-y divide-line">
              {unanswered.map((d) => (
                <li key={d.escrowId}>
                  <Link href={`/p/${d.escrowId}`} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 hover:bg-sunken">
                    <span className="text-ink">{d.service}</span>
                    <span className="text-sm text-disputed">Respond by <LocalTime value={d.respondBy} /></span>
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
        )}

        <Panel>
          <PanelHeader title="Last 30 days" />
          <div className="grid grid-cols-2 gap-6 px-5 py-5 sm:grid-cols-4">
            <Stat label="Volume" value={card.volume} sub="USDC released or releasing, before fees" />
            <Stat label="Paid calls" value={card.calls} />
            <Stat label="Delivered" value={formatPercent(card.deliveryRate)} sub={card.failed ? `${card.failed} refunded for failed checks` : undefined} />
            <Stat label="Disputed" value={card.disputed} />
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="Services" />
          {svc.length === 0 ? (
            <EmptyState title="No services yet" action={<ButtonLink href="/dashboard/services/new" size="sm">Create your first service</ButtonLink>}>
              A service is one API endpoint with a price and a promise about what it returns.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {svc.map((s) => (
                <li key={s.id}>
                  <Link href={`/dashboard/services/${s.id}`} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 hover:bg-sunken">
                    <div className="min-w-0">
                      <p className="text-ink">{s.name}</p>
                      <p className="font-mono text-[13px] text-ink-3">/x/{s.slug}</p>
                    </div>
                    <span className={cx("text-sm", s.status === "active" ? "text-released" : s.status === "paused" ? "text-held" : "text-ink-3")}>
                      {s.status === "active" ? "Live" : s.status === "paused" ? "Paused" : "Draft"}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel>
          <PanelHeader title="Recent payments" action={recent.items.length ? <Link href="/dashboard/payments" className="text-sm text-ink-3 hover:text-ink">See all</Link> : undefined} />
          {recent.items.length === 0 ? (
            <EmptyState title="No payments yet">Once a service is live, every paid call shows up here with its verdict.</EmptyState>
          ) : (
            <PaymentsTable items={recent.items.slice(0, 10)} />
          )}
        </Panel>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Panel>
            <PanelHeader title="Profile" />
            <div className="p-5">
              <ProfileForm initial={{ name: provider.name, website: provider.website, payoutAddress: provider.payoutAddress }} />
            </div>
          </Panel>
          <div className="flex flex-col gap-6">
            <Panel>
              <PanelHeader title="Request signing" description="Verify the x-backstop-signature header on every call. See the provider guide." />
              <div className="p-5"><RotateSecret /></div>
            </Panel>
            <Panel>
              <PanelHeader title="API keys" description="Manage services from code with a Bearer token." />
              <div className="p-5">
                <ApiKeys initial={keys.map((k) => ({ ...k, createdAt: k.createdAt.toISOString(), lastUsedAt: k.lastUsedAt?.toISOString() ?? null, revokedAt: k.revokedAt?.toISOString() ?? null }))} />
              </div>
            </Panel>
          </div>
        </div>
      </div>
    </>
  );
}

export default function DashboardPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <Suspense
        fallback={
          <div className="flex flex-col gap-6" role="status" aria-label="Loading dashboard">
            <Skeleton className="h-10 w-72" />
            <Skeleton className="h-28" />
            <Panel><SkeletonRows rows={4} /></Panel>
          </div>
        }
      >
        <Dashboard />
      </Suspense>
    </div>
  );
}
