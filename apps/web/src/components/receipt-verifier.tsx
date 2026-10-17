"use client";

import { useState } from "react";
import { formatUsdc } from "@backstop/core/money";
import { api, useAction } from "@/lib/api";
import { FAILURE_LABELS } from "@/lib/status";
import { Button, Field, inputClass, Notice } from "./ui";

interface Result {
  valid: boolean;
  receipt: { escrowId: string; service: string; payer: string; payee: string; amount: string; passed: boolean; reason: string; latencyMs: number; issuedAt: string } | null;
}

/** Accepts the raw x-backstop-receipt header, or the decoded JSON copied from a payment page. */
export function ReceiptVerifier() {
  const [text, setText] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const action = useAction((body: unknown) => api<Result>("/api/v1/receipts/verify", { body }));

  return (
    <div className="flex flex-col gap-6">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setLocalError(null);
          const value = text.trim();
          if (value.startsWith("{")) {
            try {
              void action.run(JSON.parse(value));
            } catch {
              setLocalError("That looks like JSON but does not parse. Paste it exactly as copied.");
            }
          } else {
            void action.run({ header: value });
          }
        }}
      >
        <Field label="Receipt" htmlFor="receipt" error={localError} hint="Paste the x-backstop-receipt header value, or the JSON copied from a payment page.">
          <textarea id="receipt" rows={6} spellCheck={false} className={`${inputClass} py-2 font-mono text-[13px]`} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
        <div>
          <Button type="submit" loading={action.pending} disabled={!text.trim()}>Verify</Button>
        </div>
      </form>

      {action.state.phase === "error" && <Notice tone="failed" title={action.state.error.message} />}
      {action.state.phase === "success" &&
        (action.state.data.valid && action.state.data.receipt ? (
          <div className="flex flex-col gap-4">
            <Notice tone="released" title="Genuine. Signed by Backstop's receipt key." />
            <dl className="divide-y divide-line rounded-md border border-line text-[15px]">
              {(
                [
                  ["Verdict", action.state.data.receipt.passed ? "Delivered as promised" : `Failed: ${FAILURE_LABELS[action.state.data.receipt.reason] ?? action.state.data.receipt.reason}`],
                  ["Service", action.state.data.receipt.service],
                  ["Amount", `${formatUsdc(BigInt(action.state.data.receipt.amount))} USDC`],
                  ["Response time", `${action.state.data.receipt.latencyMs} ms`],
                  ["Issued", new Date(Number(action.state.data.receipt.issuedAt) * 1000).toLocaleString()],
                  ["Escrow id", action.state.data.receipt.escrowId],
                  ["Payer", action.state.data.receipt.payer],
                  ["Provider", action.state.data.receipt.payee],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="grid grid-cols-[8rem_1fr] gap-3 px-4 py-2.5">
                  <dt className="text-ink-3">{k}</dt>
                  <dd className="min-w-0 font-mono text-[13px] break-all">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        ) : (
          <Notice tone="failed" title="Not a valid Backstop receipt">It was not signed by Backstop, or something in it was changed after signing.</Notice>
        ))}
    </div>
  );
}
