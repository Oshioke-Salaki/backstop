"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Check } from "@backstop/core";
import { api, useAction } from "@/lib/api";
import { formatMs } from "@/lib/format";
import { FAILURE_LABELS } from "@/lib/status";
import { Button, cx, Field, inputClass, Notice } from "./ui";

export function StatusControl({ id, status, payoutApproved }: { id: string; status: "draft" | "active" | "paused"; payoutApproved: boolean }) {
  const router = useRouter();
  const action = useAction((next: "active" | "paused") => api(`/api/v1/provider/services/${id}/status`, { body: { status: next } }));
  const next = status === "active" ? "paused" : "active";
  const label = status === "draft" ? "Publish" : status === "active" ? "Pause" : "Resume";
  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
      <Button
        variant={status === "active" ? "secondary" : "primary"}
        loading={action.pending}
        disabled={next === "active" && !payoutApproved}
        onClick={async () => {
          const r = await action.run(next);
          if (r.ok) router.refresh();
        }}
      >
        {label}
      </Button>
      {next === "active" && !payoutApproved && <p className="text-sm text-held">Waiting for payout approval.</p>}
      {action.state.phase === "error" && <p className="text-sm text-failed">{action.state.error.message}</p>}
    </div>
  );
}

interface DryRun {
  verdict: { passed: boolean; reason: string | null; checks: Check[] };
  status: number | null;
  latencyMs: number;
  bodyPreview: string;
  url: string;
}

export function DryRunPanel({ id, method }: { id: string; method: "GET" | "POST" }) {
  const [path, setPath] = useState("");
  const [query, setQuery] = useState("");
  const [body, setBody] = useState("");
  const action = useAction((input: { path: string; query: string; body?: string }) => api<{ result: DryRun }>(`/api/v1/provider/services/${id}/test`, { body: input }));

  return (
    <div className="flex flex-col gap-5">
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run({ path, query, ...(method === "POST" ? { body } : {}) });
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Extra path" htmlFor="dr-path" optional>
            <input id="dr-path" className={`${inputClass} h-10 font-mono text-[14px]`} value={path} onChange={(e) => setPath(e.target.value)} placeholder="today" />
          </Field>
          <Field label="Query string" htmlFor="dr-query" optional>
            <input id="dr-query" className={`${inputClass} h-10 font-mono text-[14px]`} value={query} onChange={(e) => setQuery(e.target.value.replace(/^\?/, ""))} placeholder="city=Lagos" />
          </Field>
        </div>
        {method === "POST" && (
          <Field label="JSON body" htmlFor="dr-body" optional>
            <textarea id="dr-body" rows={4} spellCheck={false} className={`${inputClass} py-2 font-mono text-[13px]`} value={body} onChange={(e) => setBody(e.target.value)} />
          </Field>
        )}
        <div className="flex items-center gap-3">
          <Button type="submit" variant="secondary" loading={action.pending}>
            {action.pending ? "Calling your API…" : "Run a test call"}
          </Button>
          <span className="text-sm text-ink-3">Free. Sent with an x-backstop-dry-run header.</span>
        </div>
      </form>

      {action.state.phase === "error" && <Notice tone="failed" title={action.state.error.message} />}
      {action.state.phase === "success" && <DryRunResult r={action.state.data.result} />}
    </div>
  );
}

function DryRunResult({ r }: { r: DryRun }) {
  const passed = r.verdict.passed;
  return (
    <div className="flex flex-col gap-4">
      <Notice tone={passed ? "released" : "failed"} title={passed ? "This response would be paid for" : `This response would be refunded: ${FAILURE_LABELS[r.verdict.reason ?? ""] ?? r.verdict.reason}`}>
        {r.status !== null ? `HTTP ${r.status} in ${formatMs(r.latencyMs)} from ` : "No response from "}
        <span className="font-mono text-[13px] break-all">{r.url}</span>
      </Notice>
      <ul className="divide-y divide-line rounded-md border border-line">
        {r.verdict.checks.map((c, i) => (
          <li key={i} className="grid grid-cols-[1.25rem_1fr] gap-x-3 gap-y-0.5 px-4 py-2.5 text-[15px] sm:grid-cols-[1.25rem_minmax(7rem,13rem)_1fr]">
            <span className={cx("font-medium", c.passed ? "text-released" : "text-failed")}>{c.passed ? "✓" : "✕"}</span>
            <span>{c.name}</span>
            <span className="col-start-2 min-w-0 break-words text-ink-2 sm:col-start-auto">{c.detail}</span>
          </li>
        ))}
      </ul>
      {r.bodyPreview && (
        <details>
          <summary className="cursor-pointer text-[15px] font-medium">Response body (first 4 KB)</summary>
          <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-sunken p-3 font-mono text-[12.5px] whitespace-pre-wrap">{r.bodyPreview}</pre>
        </details>
      )}
    </div>
  );
}

export function DeleteService({ id }: { id: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const action = useAction(() => api(`/api/v1/provider/services/${id}`, { method: "DELETE" }));
  return (
    <div className="flex flex-col gap-2">
      {action.state.phase === "error" && <Notice tone="failed" title={action.state.error.message} />}
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[15px] text-ink-2">Delete this draft permanently?</span>
          <Button
            variant="danger"
            size="sm"
            loading={action.pending}
            onClick={async () => {
              const r = await action.run();
              if (r.ok) {
                router.push("/dashboard");
                router.refresh();
              }
            }}
          >
            Delete
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <div>
          <Button variant="ghost" size="sm" className="text-failed" onClick={() => setConfirming(true)}>
            Delete service
          </Button>
        </div>
      )}
    </div>
  );
}
