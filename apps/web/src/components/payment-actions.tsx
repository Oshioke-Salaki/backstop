"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { formatUsdc, parseUsdc } from "@backstop/core/money";
import { DISPUTE_REASONS } from "@backstop/core/state";
import { api, useAction, type ApiFailure } from "@/lib/api";
import { Button, Field, inputClass, Notice, Spinner } from "./ui";

function withToken(path: string, token: string | null) {
  return token ? `${path}?t=${encodeURIComponent(token)}` : path;
}

function ErrorNotice({ error }: { error: ApiFailure }) {
  return <Notice tone="failed" title={error.message} />;
}

/** Keeps a live payment current without a manual reload; pauses while the tab is hidden. */
export function AutoRefresh({ intervalMs = 4000 }: { intervalMs?: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") start(() => router.refresh());
    }, intervalMs);
    return () => clearInterval(t);
  }, [router, intervalMs]);
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-ink-3" aria-live="polite">
      {pending ? <Spinner className="size-3.5" /> : <span className="inline-block size-1.5 rounded-full bg-ink-3 animate-pulse-dot" aria-hidden="true" />}
      Live
    </span>
  );
}

export function Countdown({ to }: { to: string }) {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setLeft(Math.max(0, Math.floor((new Date(to).getTime() - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [to]);
  if (left === null) return <span className="tabular">…</span>;
  if (left === 0) return <span>any moment now</span>;
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = left % 60;
  return <span className="tabular">{h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s.toString().padStart(2, "0")}s` : `${s}s`}</span>;
}

// --- Payer ---------------------------------------------------------------------

export function DisputeForm({ id, token }: { id: string; token: string | null }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [statement, setStatement] = useState("");
  const action = useAction((body: { reason: string; statement: string }) => api(withToken(`/api/v1/payments/${id}/dispute`, token), { body }));
  const fields = action.state.phase === "error" ? action.state.error.fields : {};
  const remaining = 2000 - statement.length;

  if (action.state.phase === "success") {
    return <Notice tone="disputed" title="Dispute filed">Funds stay in escrow. The provider has been asked to respond.</Notice>;
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await action.run({ reason, statement });
        if (r.ok) router.refresh();
      }}
      noValidate
    >
      {action.state.phase === "error" && !Object.keys(fields).length && <ErrorNotice error={action.state.error} />}
      <Field label="What went wrong" htmlFor="reason" error={fields.reason}>
        <select id="reason" required value={reason} onChange={(e) => setReason(e.target.value)} className={`${inputClass} h-10`} aria-invalid={!!fields.reason}>
          <option value="" disabled>
            Choose one
          </option>
          {Object.entries(DISPUTE_REASONS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Explain it" htmlFor="statement" error={fields.statement} hint={`Be specific. The provider and an arbiter will read this. ${remaining} characters left.`}>
        <textarea
          id="statement"
          required
          minLength={20}
          maxLength={2000}
          rows={4}
          value={statement}
          onChange={(e) => setStatement(e.target.value)}
          className={`${inputClass} py-2`}
          aria-invalid={!!fields.statement}
        />
      </Field>
      <div>
        <Button type="submit" loading={action.pending} disabled={!reason || statement.trim().length < 20}>
          File dispute
        </Button>
      </div>
    </form>
  );
}

export function WithdrawButton({ id, token }: { id: string; token: string | null }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const action = useAction(() => api(withToken(`/api/v1/payments/${id}/withdraw`, token), { method: "POST", body: {} }));
  return (
    <div className="flex flex-col gap-3">
      {action.state.phase === "error" && <ErrorNotice error={action.state.error} />}
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[15px] text-ink-2">The provider will be paid. Continue?</span>
          <Button
            variant="danger"
            size="sm"
            loading={action.pending}
            onClick={async () => {
              const r = await action.run();
              if (r.ok) router.refresh();
            }}
          >
            Withdraw dispute
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={action.pending}>
            Keep it
          </Button>
        </div>
      ) : (
        <div>
          <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>
            Withdraw dispute
          </Button>
        </div>
      )}
    </div>
  );
}

// --- Provider ----------------------------------------------------------------------

export function RespondForm({ id, existing }: { id: string; existing: string | null }) {
  const router = useRouter();
  const [statement, setStatement] = useState(existing ?? "");
  const action = useAction((body: { statement: string }) => api(`/api/v1/payments/${id}/respond`, { body }));
  const fields = action.state.phase === "error" ? action.state.error.fields : {};
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await action.run({ statement });
        if (r.ok) router.refresh();
      }}
    >
      {action.state.phase === "error" && !fields.statement && <ErrorNotice error={action.state.error} />}
      {action.state.phase === "success" && <Notice tone="released" title="Response saved">The arbiter will see it. You can edit it until the dispute is resolved.</Notice>}
      <Field label={existing ? "Your response" : "Respond to the payer"} htmlFor="response" error={fields.statement} hint="Explain what you delivered and why it met your promise.">
        <textarea id="response" rows={4} maxLength={2000} value={statement} onChange={(e) => setStatement(e.target.value)} className={`${inputClass} py-2`} aria-invalid={!!fields.statement} />
      </Field>
      <div>
        <Button type="submit" loading={action.pending} disabled={statement.trim().length < 10}>
          {existing ? "Update response" : "Send response"}
        </Button>
      </div>
    </form>
  );
}

export function RefundButton({ id, amount }: { id: string; amount: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const action = useAction(() => api(`/api/v1/payments/${id}/refund`, { method: "POST", body: {} }));
  return (
    <div className="flex flex-col gap-3">
      {action.state.phase === "error" && <ErrorNotice error={action.state.error} />}
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[15px] text-ink-2">Return {amount} USDC to the payer?</span>
          <Button
            variant="danger"
            size="sm"
            loading={action.pending}
            onClick={async () => {
              const r = await action.run();
              if (r.ok) router.refresh();
            }}
          >
            Refund in full
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={action.pending}>
            Cancel
          </Button>
        </div>
      ) : (
        <div>
          <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>
            Refund the payer
          </Button>
        </div>
      )}
    </div>
  );
}

// --- Arbiter -----------------------------------------------------------------------

export function ResolveForm({ id, amount }: { id: string; amount: string }) {
  const router = useRouter();
  const [decision, setDecision] = useState<"release" | "refund" | "split">("refund");
  const [payerShare, setPayerShare] = useState("");
  const [note, setNote] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const action = useAction((body: Record<string, string>) => api(`/api/v1/payments/${id}/resolve`, { body }));
  const total = parseUsdc(amount);
  const halfway = formatUsdc(total / 2n);

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setLocalError(null);
        const body: Record<string, string> = { decision, note };
        if (decision === "split") {
          let share: bigint;
          try {
            share = parseUsdc(payerShare);
          } catch {
            return setLocalError("Enter the payer's share as an amount, like 0.02.");
          }
          if (share > total) return setLocalError(`The payer's share cannot exceed ${amount} USDC.`);
          body.payerAmount = share.toString();
        }
        const r = await action.run(body);
        if (r.ok) router.refresh();
      }}
    >
      {action.state.phase === "error" && <ErrorNotice error={action.state.error} />}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">Decision</legend>
        {(
          [
            ["refund", "Refund the payer in full"],
            ["release", "Pay the provider"],
            ["split", "Split it"],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="flex items-center gap-2 text-[15px]">
            <input type="radio" name="decision" value={value} checked={decision === value} onChange={() => setDecision(value)} className="accent-[var(--accent)]" />
            {label}
          </label>
        ))}
      </fieldset>
      {decision === "split" && (
        <Field label="Payer receives (USDC)" htmlFor="share" error={localError} hint={`Out of ${amount}. The provider receives the rest, less the fee on their part.`}>
          <input id="share" inputMode="decimal" value={payerShare} onChange={(e) => setPayerShare(e.target.value)} className={`${inputClass} h-10`} placeholder={halfway} />
        </Field>
      )}
      {decision !== "split" && localError && <Notice tone="failed" title={localError} />}
      <Field label="Reasoning" htmlFor="note" hint="Both parties see this.">
        <textarea id="note" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} className={`${inputClass} py-2`} />
      </Field>
      <div>
        <Button type="submit" loading={action.pending} disabled={note.trim().length < 5}>
          Resolve dispute
        </Button>
      </div>
    </form>
  );
}
