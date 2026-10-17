import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import type { Assertion } from "@backstop/core";
import { CopyButton } from "@/components/client";
import { Panel, PanelHeader, Skeleton, Stat } from "@/components/ui";
import { formatDuration, formatMs, formatPercent } from "@/lib/format";
import { scorecard } from "@/server/payments";
import { getPublicService } from "@/server/services";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: slug };
}

function describeAssertion(a: Assertion): string {
  const at = a.path || "the whole response";
  switch (a.op) {
    case "exists":
      return `${at} is present`;
    case "nonEmpty":
      return `${at} is not empty`;
    case "equals":
      return `${at} equals ${JSON.stringify(a.value)}`;
    case "minItems":
      return `${at} has at least ${a.value} items`;
    case "maxItems":
      return `${at} has at most ${a.value} items`;
    case "minLength":
      return `${at} is at least ${a.value} characters`;
    case "gte":
      return `${at} is at least ${a.value}`;
    case "lte":
      return `${at} is at most ${a.value}`;
    case "oneOf":
      return `${at} is one of ${a.value.map((v) => JSON.stringify(v)).join(", ")}`;
  }
}

function formatBytes(n: number) {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`;
}

async function Record({ serviceId }: { serviceId: string }) {
  await connection();
  const s = await scorecard({ serviceId });
  if (s.calls === 0) {
    return <p className="px-5 py-6 text-[15px] text-ink-3">No paid calls in the last {s.windowDays} days yet, so there is no track record to show.</p>;
  }
  return (
    <div className="grid grid-cols-2 gap-6 px-5 py-6 sm:grid-cols-4">
      <Stat label="Delivered" value={formatPercent(s.deliveryRate)} sub={`${s.delivered} of ${s.delivered + s.failed} checked`} />
      <Stat label="Refunded" value={formatPercent(s.refundRate)} sub={`${s.calls} paid calls`} />
      <Stat label="Median response" value={formatMs(s.p50LatencyMs)} sub={`p95 ${formatMs(s.p95LatencyMs)}`} />
      <Stat label="Disputed" value={s.disputed} sub={`last ${s.windowDays} days`} />
    </div>
  );
}

async function Detail({ params }: Props) {
  await connection();
  const { slug } = await params;
  const s = await getPublicService(slug);
  if (!s) notFound();
  const example = `curl -i ${s.method === "POST" ? "-X POST -H 'content-type: application/json' -d '{}' " : ""}${s.resource}`;

  return (
    <>
      <header className="mb-10 flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-2xl">
          <p className="text-sm text-ink-3">
            {s.provider.website ? (
              <a href={s.provider.website} target="_blank" rel="noreferrer" className="hover:text-ink">
                {s.provider.name}
              </a>
            ) : (
              s.provider.name
            )}
          </p>
          <h1 className="mt-1 text-[32px] leading-tight font-medium tracking-tight">{s.name}</h1>
          <p className="mt-3 text-[17px] text-ink-2">{s.description}</p>
          {s.status === "paused" && <p className="mt-3 text-[15px] text-held">Paused by the provider. Calls are refused before any payment.</p>}
        </div>
        <p className="tabular text-[28px] font-medium">
          {s.price} <span className="text-base font-normal text-ink-3">USDC per call</span>
        </p>
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.2fr_1fr]">
        <Panel>
          <PanelHeader title="What the provider promises" description="Backstop checks every response against these. A miss is refunded in full." />
          <dl className="divide-y divide-line">
            <Row label="Responds within">{formatMs(s.sla.maxLatencyMs)}</Row>
            <Row label="Status">{s.sla.expectStatus.join(" or ")}</Row>
            <Row label="Format">{s.sla.contentType}</Row>
            <Row label="Size">up to {formatBytes(s.sla.maxResponseBytes)}</Row>
            <Row label="Shape">{s.sla.outputSchema ? "Matches a published JSON Schema" : "Not specified"}</Row>
            {s.sla.assertions.map((a, i) => (
              <Row key={i} label={i === 0 ? "Field rules" : ""}>
                {describeAssertion(a)}
              </Row>
            ))}
            <Row label="Dispute window">
              {s.disputeWindowSeconds === 0 ? "None. Payment releases as soon as checks pass." : `${formatDuration(s.disputeWindowSeconds)} after delivery`}
            </Row>
          </dl>
        </Panel>

        <div className="flex min-w-0 flex-col gap-6">
          <Panel>
            <PanelHeader title="Call it" />
            <div className="flex flex-col gap-4 px-5 py-5">
              <div>
                <p className="text-sm text-ink-3">Resource ({s.method})</p>
                <div className="mt-1 flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-sm bg-sunken px-2 py-1.5 font-mono text-[13px]">{s.resource}</code>
                  <CopyButton value={s.resource} />
                </div>
              </div>
              <pre className="overflow-x-auto rounded-md bg-ink p-4 font-mono text-[12.5px] leading-relaxed text-ground">
                <code>{`${example}\n# → 402 with escrow terms. Pay with PayBox pay_x402\n#   and retry with the X-PAYMENT header.`}</code>
              </pre>
            </div>
          </Panel>
          {(s.inputSchema || s.sla.outputSchema) && (
            <Panel>
              <PanelHeader title="Schemas" />
              <div className="flex flex-col gap-4 px-5 py-5">
                {s.inputSchema && <SchemaBlock title="Accepted input" schema={s.inputSchema} />}
                {s.sla.outputSchema && <SchemaBlock title="Promised output" schema={s.sla.outputSchema} />}
              </div>
            </Panel>
          )}
        </div>
      </div>

      <Panel className="mt-6">
        <PanelHeader title="Track record" description="Last 30 days of paid calls, straight from escrow records." />
        <Suspense fallback={<div className="grid grid-cols-2 gap-6 px-5 py-6 sm:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-14" />)}</div>}>
          <Record serviceId={s.id} />
        </Suspense>
      </Panel>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-4 px-5 py-3 text-[15px]">
      <dt className="text-ink-3">{label}</dt>
      <dd className="min-w-0 text-ink">{children}</dd>
    </div>
  );
}

function SchemaBlock({ title, schema }: { title: string; schema: Record<string, unknown> }) {
  return (
    <details className="group">
      <summary className="cursor-pointer text-[15px] font-medium text-ink">{title}</summary>
      <pre className="mt-2 max-h-80 overflow-auto rounded-md bg-sunken p-3 font-mono text-[12.5px]">{JSON.stringify(schema, null, 2)}</pre>
    </details>
  );
}

export default function ServicePage(props: Props) {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <Suspense
        fallback={
          <div className="flex flex-col gap-4">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-10 w-2/3" />
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="mt-6 h-72" />
          </div>
        }
      >
        <Detail {...props} />
      </Suspense>
    </div>
  );
}
