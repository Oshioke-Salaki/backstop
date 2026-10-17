import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { eq } from "drizzle-orm";
import { DeleteService, DryRunPanel, StatusControl } from "@/components/service-controls";
import { ServiceForm, type ServiceFormValues } from "@/components/service-form";
import { CopyButton } from "@/components/client";
import { PageHeader, Panel, PanelHeader, Skeleton, Stat } from "@/components/ui";
import { formatMs, formatPercent } from "@/lib/format";
import { getDb } from "@/server/db/client";
import { escrows } from "@/server/db/schema";
import { scorecard } from "@/server/payments";
import { pageSession } from "@/server/page-session";
import { getProviderForOwner } from "@/server/providers";
import { getOwnedService, toView } from "@/server/services";
import { ApiError } from "@/server/http";

export const metadata: Metadata = { title: "Service" };

type Props = { params: Promise<{ id: string }> };

async function Editor({ params }: Props) {
  const [{ id }, session] = await Promise.all([params, pageSession()]);
  if (!session) redirect(`/signin?next=/dashboard/services/${id}`);
  const provider = await getProviderForOwner(session.address);
  if (!provider) redirect("/dashboard");
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  let service;
  try {
    service = await getOwnedService(provider.id, id);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }
  const db = await getDb();
  const [[used], card] = await Promise.all([db.select({ id: escrows.id }).from(escrows).where(eq(escrows.serviceId, id)).limit(1), scorecard({ serviceId: id })]);
  const view = toView(service, provider, true);
  const initial: ServiceFormValues = {
    id: service.id,
    slug: service.slug,
    name: service.name,
    description: service.description,
    upstreamUrl: service.upstreamUrl,
    method: service.method,
    price: view.price,
    disputeWindowSeconds: service.disputeWindowSeconds,
    sla: { ...service.sla, assertions: service.sla.assertions as ServiceFormValues["sla"]["assertions"] },
    inputSchema: service.inputSchema ?? null,
  };

  return (
    <>
      <PageHeader
        title={service.name}
        back={{ href: "/dashboard", label: "Dashboard" }}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className={service.status === "active" ? "text-released" : service.status === "paused" ? "text-held" : "text-ink-3"}>
              {service.status === "active" ? "Live" : service.status === "paused" ? "Paused" : "Draft, visible only to you"}
            </span>
            <span className="text-ink-3">·</span>
            <span className="font-mono text-[14px]">{view.resource}</span>
            <CopyButton value={view.resource} />
          </span>
        }
        action={<StatusControl id={service.id} status={service.status} payoutApproved={provider.payoutApproved} />}
      />

      <div className="flex flex-col gap-6">
        {card.calls > 0 && (
          <Panel>
            <PanelHeader title="Last 30 days" action={service.status !== "draft" ? <Link href={`/services/${service.slug}`} className="text-sm text-ink-3 hover:text-ink">Public page</Link> : undefined} />
            <div className="grid grid-cols-2 gap-6 px-5 py-5 sm:grid-cols-4">
              <Stat label="Paid calls" value={card.calls} />
              <Stat label="Delivered" value={formatPercent(card.deliveryRate)} />
              <Stat label="Median response" value={formatMs(card.p50LatencyMs)} />
              <Stat label="Volume" value={card.volume} sub="USDC, before fees" />
            </div>
          </Panel>
        )}

        <Panel>
          <PanelHeader title="Test against your live API" description="See exactly what Backstop would decide for a real call, without anyone paying." />
          <div className="p-5"><DryRunPanel id={service.id} method={service.method} /></div>
        </Panel>

        <Panel>
          <PanelHeader title="Terms" description="Changes apply to new calls. Payments already in escrow keep the terms they were made under." />
          <div className="p-5"><ServiceForm initial={initial} slugLocked={!!used} /></div>
        </Panel>

        {!used && (
          <div className="px-1"><DeleteService id={service.id} /></div>
        )}
      </div>
    </>
  );
}

export default function ServiceEditorPage(props: Props) {
  return (
    <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
      <Suspense fallback={<div className="flex flex-col gap-4"><Skeleton className="h-10 w-80" /><Skeleton className="h-40" /><Skeleton className="h-96" /></div>}>
        <Editor {...props} />
      </Suspense>
    </div>
  );
}
