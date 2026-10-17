import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { DISPUTE_REASONS, type DisputeReason } from "@backstop/core/state";
import { Address, CopyButton, LocalTime, TimeAgo } from "@/components/client";
import { AutoRefresh, Countdown, DisputeForm, RefundButton, ResolveForm, RespondForm, WithdrawButton } from "@/components/payment-actions";
import { buttonClass, cx, Notice, Panel, PanelHeader, Skeleton, StatusMark } from "@/components/ui";
import { formatMs } from "@/lib/format";
import { EVENT_LABELS, FAILURE_LABELS, STATUS } from "@/lib/status";
import { providerIdFor } from "@/server/auth";
import { getPayment, viewerFor, type PaymentView, type Viewer } from "@/server/payments";
import { pageSession } from "@/server/page-session";

export const metadata: Metadata = { title: "Payment", robots: { index: false, follow: false } };

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ t?: string }> };

function NoAccess() {
  return (
    <div className="max-w-xl">
      <h1 className="text-[28px] leading-tight font-medium tracking-tight">This payment link does not work</h1>
      <p className="mt-3 text-[15px] text-ink-2">
        The link may be incomplete, or it belongs to a different payment. Ask your agent for the full link it received (it ends in <span className="font-mono">?t=…</span>), or sign in with the wallet that paid.
      </p>
      <div className="mt-6 flex gap-3">
        <Link href="/signin" className={buttonClass("primary")}>Sign in</Link>
        <Link href="/" className={buttonClass("ghost")}>Go home</Link>
      </div>
    </div>
  );
}

async function Payment({ params, searchParams }: Props) {
  const [{ id }, { t }, session] = await Promise.all([params, searchParams, pageSession()]);
  if (!/^0x[0-9a-fA-F]{64}$/.test(id)) return <NoAccess />;
  const providerId = session ? await providerIdFor({ kind: "user", session }) : null;
  const viewer = await viewerFor(id, { token: t ?? null, session, providerId });
  if (!viewer) return <NoAccess />;
  const p = await getPayment(id, viewer);
  return <PaymentDetail p={p} viewer={viewer} token={viewer === "payer" && t ? t : null} />;
}

function PaymentDetail({ p, viewer, token }: { p: PaymentView; viewer: Viewer; token: string | null }) {
  const meta = STATUS[p.status];
  const explain =
    viewer === "payer"
      ? meta.payer
      : viewer === "admin" && p.status === "disputed"
        ? "Read both sides and the delivery checks, then decide. Funds stay in escrow until you do."
        : meta.provider;
  const reason = p.failureReason ? FAILURE_LABELS[p.failureReason] ?? p.failureReason : null;
  const tx = (hash: string | null) => (hash && p.explorerUrl ? `${p.explorerUrl}${hash}` : undefined);

  return (
    <>
      <header className="flex flex-col gap-6 border-b border-line pb-8 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <StatusMark status={p.status} size="lg" />
            {meta.live && <AutoRefresh />}
          </div>
          <h1 className="mt-3 text-[32px] leading-tight font-medium tracking-tight sm:text-[40px]">
            <span className="tabular">{p.amount}</span> <span className="text-ink-3">USDC</span>
          </h1>
          <p className="mt-1 text-[15px] text-ink-2">
            to{" "}
            <Link href={`/services/${p.service.slug}`} className="text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink">
              {p.service.name}
            </Link>{" "}
            by {p.service.providerName} · <TimeAgo value={p.createdAt} />
          </p>
        </div>
        <div className="max-w-md text-[15px] text-ink-2 md:text-right">
          <p>{explain}</p>
          {reason && p.status !== "release_pending" && p.status !== "released" && <p className="mt-1 text-ink">{reason}.</p>}
          {p.status === "release_pending" && p.releaseAt && (
            <p className="mt-1 text-ink">
              Releases in <Countdown to={new Date(p.releaseAt).toISOString()} />
            </p>
          )}
        </div>
      </header>

      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[1.35fr_1fr]">
        <div className="flex flex-col gap-6">
          {p.outcome && (
            <Panel>
              <PanelHeader title={meta.live ? "Where the money is heading" : "Where the money went"} />
              <dl className="grid grid-cols-3 divide-x divide-line">
                {(
                  [
                    ["Payer", p.outcome.payer],
                    ["Provider", p.outcome.payee],
                    ["Fee", p.outcome.fee],
                  ] as const
                ).map(([k, v]) => (
                  <div key={k} className="px-5 py-4">
                    <dt className="text-sm text-ink-3">{k}</dt>
                    <dd className="tabular mt-1 text-lg font-medium">{v}</dd>
                  </div>
                ))}
              </dl>
            </Panel>
          )}

          <DisputeSection p={p} viewer={viewer} token={token} />

          {p.verdict && (
            <Panel>
              <PanelHeader
                title="Delivery checks"
                description={p.verdict.passed ? "Every promised check passed." : "Stopped at the first failed check."}
              />
              <ul className="divide-y divide-line">
                {p.verdict.checks.map((c, i) => (
                  <li key={i} className="grid grid-cols-[1.25rem_1fr] items-baseline gap-x-3 gap-y-0.5 px-5 py-3 text-[15px] sm:grid-cols-[1.25rem_minmax(7rem,13rem)_1fr]">
                    <span aria-label={c.passed ? "passed" : "failed"} className={cx("font-medium", c.passed ? "text-released" : "text-failed")}>
                      {c.passed ? "✓" : "✕"}
                    </span>
                    <span className="text-ink">{c.name}</span>
                    <span className="col-start-2 min-w-0 break-words text-ink-2 sm:col-start-auto">{c.detail}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>

        <div className="flex flex-col gap-6">
          <Panel>
            <PanelHeader title="Timeline" />
            {p.events.length === 0 ? (
              <p className="px-5 py-4 text-[15px] text-ink-3">No events recorded yet.</p>
            ) : (
              <ol className="flex flex-col px-5 py-4">
                {p.events.map((e, i) => (
                  <li key={e.id} className="relative grid grid-cols-[1rem_1fr] gap-3 pb-4 last:pb-0">
                    <span className="relative flex justify-center">
                      <span className={cx("mt-2 inline-block size-2 rounded-full", i === p.events.length - 1 ? "bg-accent" : "bg-line-strong")} />
                      {i < p.events.length - 1 && <span className="absolute top-4 bottom-[-0.5rem] w-px bg-line" aria-hidden="true" />}
                    </span>
                    <div className="min-w-0">
                      <p className="text-[15px] text-ink">{EVENT_LABELS[e.type] ?? e.type}</p>
                      <p className="text-sm text-ink-3"><LocalTime value={e.createdAt} /></p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Panel>

          <Panel>
            <PanelHeader title="Proof" description="Everything here can be checked independently on-chain." />
            <dl className="flex flex-col divide-y divide-line text-[15px]">
              <Detail label="Escrow id">
                <Address value={p.id} />
              </Detail>
              <Detail label="Payer">
                <Address value={p.payer} />
              </Detail>
              <Detail label="Provider payout">
                <Address value={p.payee} />
              </Detail>
              {p.depositTx && (
                <Detail label="Deposit">
                  <Address value={p.depositTx} href={tx(p.depositTx)} />
                </Detail>
              )}
              {p.settleTx && (
                <Detail label="Settlement">
                  <Address value={p.settleTx} href={tx(p.settleTx)} />
                </Detail>
              )}
              {p.latencyMs !== null && <Detail label="Response time">{formatMs(p.latencyMs)}</Detail>}
              {p.deadline && <Detail label="Reclaim opens"><LocalTime value={p.deadline} /></Detail>}
              {p.receipt && (
                <Detail label="Signed receipt">
                  <span className="inline-flex items-center gap-1">
                    <Link href="/verify" className="text-ink underline decoration-line-strong underline-offset-2">
                      Verify
                    </Link>
                    <CopyButton value={JSON.stringify(p.receipt)} label="Copy JSON" />
                  </span>
                </Detail>
              )}
            </dl>
          </Panel>
        </div>
      </div>
    </>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5">
      <dt className="text-ink-3">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function DisputeSection({ p, viewer, token }: { p: PaymentView; viewer: Viewer; token: string | null }) {
  const d = p.dispute;
  if (!d && !p.canDispute && !p.canRefund) return null;

  return (
    <Panel>
      <PanelHeader
        title={d ? (d.status === "open" ? "Dispute" : "Dispute resolved") : viewer === "payer" ? "Something wrong with this delivery?" : "Refund"}
        description={
          d
            ? d.status === "open"
              ? <>Provider must respond by <LocalTime value={d.respondBy} />, or the payer is refunded automatically.</>
              : <>Resolved {d.resolution === "release" ? "for the provider" : d.resolution === "refund" ? "for the payer" : "with a split"}{d.resolvedAt ? <> on <LocalTime value={d.resolvedAt} /></> : null}.</>
            : viewer === "payer" && p.releaseAt
              ? "It passed the automatic checks, but you can still dispute it before the window closes."
              : "You can return this payment before it releases."
        }
      />
      <div className="flex flex-col gap-5 px-5 py-5">
        {d && (
          <div className="flex flex-col gap-4">
            <Statement who="Payer" title={DISPUTE_REASONS[d.reason as DisputeReason] ?? d.reason} text={d.payerStatement} />
            {d.providerStatement ? (
              <Statement who="Provider" text={d.providerStatement} />
            ) : (
              d.status === "open" && <p className="text-[15px] text-ink-3">The provider has not responded yet.</p>
            )}
            {d.resolutionNote && <Statement who="Decision" text={d.resolutionNote} />}
          </div>
        )}

        {p.canDispute && !d && <DisputeForm id={p.id} token={token} />}
        {p.canWithdraw && <WithdrawButton id={p.id} token={token} />}
        {p.canRespond && d && <RespondForm id={p.id} existing={d.providerStatement} />}
        {p.canRefund && <RefundButton id={p.id} amount={p.amount} />}
        {p.canResolve && (
          <div className="border-t border-line pt-5">
            <ResolveForm id={p.id} amount={p.amount} />
          </div>
        )}
        {d?.status === "resolved" && p.status === "disputed" && <Notice tone="disputed" title="Settling on-chain">The decision is final. Funds move within a minute.</Notice>}
      </div>
    </Panel>
  );
}

function Statement({ who, title, text }: { who: string; title?: string; text: string }) {
  return (
    <div>
      <p className="text-sm text-ink-3">
        {who}
        {title && <span className="text-ink"> · {title}</span>}
      </p>
      <p className="mt-1 text-[15px] whitespace-pre-wrap text-ink">{text}</p>
    </div>
  );
}

export default function PaymentPage(props: Props) {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <Suspense
        fallback={
          <div className="flex flex-col gap-4" role="status" aria-label="Loading payment">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-12 w-64" />
            <Skeleton className="h-5 w-80" />
            <div className="mt-6 grid gap-6 lg:grid-cols-[1.35fr_1fr]">
              <Skeleton className="h-64" />
              <Skeleton className="h-64" />
            </div>
          </div>
        }
      >
        <Payment {...props} />
      </Suspense>
    </div>
  );
}
