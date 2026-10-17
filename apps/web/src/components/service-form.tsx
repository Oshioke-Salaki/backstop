"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { api, useAction } from "@/lib/api";
import { Button, cx, Field, inputClass, Notice } from "./ui";

type Op = "exists" | "nonEmpty" | "equals" | "minItems" | "maxItems" | "minLength" | "gte" | "lte" | "oneOf";

interface AssertionRow {
  key: number;
  op: Op;
  path: string;
  value: string;
}

export interface ServiceFormValues {
  id?: string;
  slug: string;
  name: string;
  description: string;
  upstreamUrl: string;
  method: "GET" | "POST";
  price: string;
  disputeWindowSeconds: number;
  sla: {
    maxLatencyMs: number;
    maxResponseBytes: number;
    expectStatus: number[];
    contentType: string;
    outputSchema?: Record<string, unknown>;
    assertions: Array<{ op: Op; path: string; value?: unknown }>;
  };
  inputSchema: Record<string, unknown> | null;
}

const OPS: Array<{ op: Op; label: string; needsValue: boolean; placeholder?: string }> = [
  { op: "exists", label: "is present", needsValue: false },
  { op: "nonEmpty", label: "is not empty", needsValue: false },
  { op: "equals", label: "equals", needsValue: true, placeholder: '"ok" or 1 or true' },
  { op: "gte", label: "is at least", needsValue: true, placeholder: "0" },
  { op: "lte", label: "is at most", needsValue: true, placeholder: "100" },
  { op: "minItems", label: "has at least N items", needsValue: true, placeholder: "1" },
  { op: "maxItems", label: "has at most N items", needsValue: true, placeholder: "50" },
  { op: "minLength", label: "has at least N characters", needsValue: true, placeholder: "1" },
  { op: "oneOf", label: "is one of", needsValue: true, placeholder: '"a", "b", "c"' },
];

const WINDOWS: Array<[number, string]> = [
  [0, "None: release when checks pass"],
  [900, "15 minutes"],
  [3600, "1 hour"],
  [86400, "24 hours"],
  [259200, "3 days"],
  [604800, "7 days"],
];

const LATENCIES = [500, 1000, 2000, 5000, 10000, 30000, 60000];

export const DEFAULT_VALUES: ServiceFormValues = {
  slug: "",
  name: "",
  description: "",
  upstreamUrl: "",
  method: "GET",
  price: "0.01",
  disputeWindowSeconds: 3600,
  sla: { maxLatencyMs: 5000, maxResponseBytes: 256 * 1024, expectStatus: [200], contentType: "application/json", assertions: [] },
  inputSchema: null,
};

function slugify(name: string) {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 48);
}

/** A starting schema from a sample response: types, and every present key required. */
export function inferSchema(value: unknown): Record<string, unknown> {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) return value.length ? { type: "array", items: inferSchema(value[0]) } : { type: "array" };
  switch (typeof value) {
    case "number":
      return { type: Number.isInteger(value) ? "integer" : "number" };
    case "string":
      return { type: "string" };
    case "boolean":
      return { type: "boolean" };
    case "object": {
      const entries = Object.entries(value as Record<string, unknown>);
      return { type: "object", required: entries.map(([k]) => k), properties: Object.fromEntries(entries.map(([k, v]) => [k, inferSchema(v)])) };
    }
    default:
      return {};
  }
}

function parseJsonObject(text: string): { value: Record<string, unknown> | null; error: string | null } {
  if (!text.trim()) return { value: null, error: null };
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) return { value: null, error: "A schema must be a JSON object." };
    return { value: v, error: null };
  } catch (e) {
    return { value: null, error: `Not valid JSON: ${(e as Error).message}` };
  }
}

function parseAssertionValue(op: Op, raw: string): { value?: unknown; error?: string } {
  const text = raw.trim();
  if (op === "exists" || op === "nonEmpty") return {};
  if (!text) return { error: "Add a value." };
  if (op === "gte" || op === "lte" || op === "minItems" || op === "maxItems" || op === "minLength") {
    const n = Number(text);
    if (!Number.isFinite(n)) return { error: "Enter a number." };
    if (op !== "gte" && op !== "lte" && (!Number.isInteger(n) || n < 0)) return { error: "Enter a whole number." };
    return { value: n };
  }
  try {
    return { value: op === "oneOf" ? JSON.parse(`[${text}]`) : JSON.parse(text) };
  } catch {
    return op === "equals" ? { value: text } : { error: 'Separate JSON values with commas, like "a", "b".' };
  }
}

export function ServiceForm({ initial, slugLocked = false }: { initial: ServiceFormValues; slugLocked?: boolean }) {
  const router = useRouter();
  const editing = !!initial.id;
  const [v, setV] = useState(initial);
  const [slugTouched, setSlugTouched] = useState(editing);
  const [schemaText, setSchemaText] = useState(initial.sla.outputSchema ? JSON.stringify(initial.sla.outputSchema, null, 2) : "");
  const [inputText, setInputText] = useState(initial.inputSchema ? JSON.stringify(initial.inputSchema, null, 2) : "");
  const [sample, setSample] = useState("");
  const [sampleError, setSampleError] = useState<string | null>(null);
  const [rows, setRows] = useState<AssertionRow[]>(
    initial.sla.assertions.map((a, i) => ({
      key: i,
      op: a.op,
      path: a.path,
      value: a.value === undefined ? "" : a.op === "oneOf" ? (a.value as unknown[]).map((x) => JSON.stringify(x)).join(", ") : typeof a.value === "string" ? a.value : JSON.stringify(a.value),
    })),
  );
  const [statusText, setStatusText] = useState(initial.sla.expectStatus.join(", "));

  const schema = useMemo(() => parseJsonObject(schemaText), [schemaText]);
  const inputSchema = useMemo(() => parseJsonObject(inputText), [inputText]);
  const rowErrors = rows.map((r) => {
    if (r.path && !r.path.startsWith("/")) return "Paths start with /, like /data/0/name.";
    return parseAssertionValue(r.op, r.value).error ?? null;
  });
  const statuses = statusText.split(/[\s,]+/).filter(Boolean).map(Number);
  const statusError = statuses.length === 0 || statuses.some((s) => !Number.isInteger(s) || s < 200 || s > 299) ? "List 2xx codes, like 200 or 200, 201." : null;
  const isJson = /json/i.test(v.sla.contentType);

  const action = useAction((body: unknown) =>
    api<{ service: { id: string } }>(editing ? `/api/v1/provider/services/${initial.id}` : "/api/v1/provider/services", { method: editing ? "PUT" : "POST", body }),
  );
  const fields = action.state.phase === "error" ? action.state.error.fields : {};
  const fieldError = (prefix: string) => Object.entries(fields).find(([k]) => k === prefix || k.startsWith(`${prefix}.`))?.[1] ?? null;
  const localInvalid = !!schema.error || !!inputSchema.error || rowErrors.some(Boolean) || !!statusError;

  const set = <K extends keyof ServiceFormValues>(k: K, value: ServiceFormValues[K]) => setV((s) => ({ ...s, [k]: value }));
  const setSla = <K extends keyof ServiceFormValues["sla"]>(k: K, value: ServiceFormValues["sla"][K]) => setV((s) => ({ ...s, sla: { ...s.sla, [k]: value } }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (localInvalid) return;
    const body = {
      slug: v.slug,
      name: v.name,
      description: v.description,
      upstreamUrl: v.upstreamUrl,
      method: v.method,
      price: v.price,
      disputeWindowSeconds: v.disputeWindowSeconds,
      inputSchema: inputSchema.value,
      sla: {
        maxLatencyMs: v.sla.maxLatencyMs,
        maxResponseBytes: v.sla.maxResponseBytes,
        expectStatus: statuses,
        contentType: v.sla.contentType,
        ...(isJson && schema.value ? { outputSchema: schema.value } : {}),
        assertions: isJson
          ? rows.filter((r) => r.path || r.op !== "exists").map((r) => {
              const parsed = parseAssertionValue(r.op, r.value);
              return parsed.value === undefined ? { op: r.op, path: r.path } : { op: r.op, path: r.path, value: parsed.value };
            })
          : [],
      },
    };
    const r = await action.run(body);
    if (r.ok) {
      if (editing) router.refresh();
      else router.push(`/dashboard/services/${r.data.service.id}`);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-10">
      {action.state.phase === "error" && (
        <Notice tone="failed" title={Object.keys(fields).length ? "Some fields need attention" : action.state.error.message}>
          {Object.keys(fields).length ? "They are marked below." : null}
        </Notice>
      )}
      {action.state.phase === "success" && editing && <Notice tone="released" title="Saved. New calls use these terms immediately." />}

      <Section title="The service" description="What agents and their users see.">
        <Field label="Name" htmlFor="name" error={fields.name}>
          <input
            id="name"
            className={`${inputClass} h-10`}
            value={v.name}
            maxLength={80}
            onChange={(e) => {
              const name = e.target.value;
              setV((s) => ({ ...s, name, slug: slugTouched ? s.slug : slugify(name) }));
            }}
          />
        </Field>
        <Field
          label="URL name"
          htmlFor="slug"
          error={fields.slug}
          hint={slugLocked ? "Locked: agents already pay this URL." : <>Agents call <span className="font-mono">/x/{v.slug || "your-service"}</span></>}
        >
          <input
            id="slug"
            className={`${inputClass} h-10 font-mono text-[14px]`}
            value={v.slug}
            disabled={slugLocked}
            maxLength={48}
            onChange={(e) => {
              setSlugTouched(true);
              set("slug", e.target.value.toLowerCase());
            }}
          />
        </Field>
        <Field label="Description" htmlFor="description" error={fields.description} hint={`${500 - v.description.length} characters left.`}>
          <textarea id="description" rows={3} maxLength={500} className={`${inputClass} py-2`} value={v.description} onChange={(e) => set("description", e.target.value)} />
        </Field>
        <div className="grid gap-5 sm:grid-cols-[10rem_1fr]">
          <Field label="Method" htmlFor="method">
            <div id="method" role="radiogroup" className="inline-flex h-10 rounded-md bg-sunken p-1">
              {(["GET", "POST"] as const).map((m) => (
                <button
                  type="button"
                  key={m}
                  role="radio"
                  aria-checked={v.method === m}
                  onClick={() => set("method", m)}
                  className={cx("flex-1 rounded-sm px-3 text-sm font-medium", v.method === m ? "bg-surface text-ink" : "text-ink-3")}
                >
                  {m}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Your API's URL" htmlFor="upstream" error={fields.upstreamUrl} hint="Backstop calls this after payment is locked. Extra path segments are appended.">
            <input id="upstream" type="url" className={`${inputClass} h-10 font-mono text-[14px]`} placeholder="https://api.example.com/v1/forecast" value={v.upstreamUrl} onChange={(e) => set("upstreamUrl", e.target.value.trim())} spellCheck={false} />
          </Field>
        </div>
      </Section>

      <Section title="Price and protection" description="Agents pay this per call. The dispute window is how long funds wait before release.">
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Price per call (USDC)" htmlFor="price" error={fields.price} hint="Between 0.001 and 1000.">
            <input id="price" inputMode="decimal" className={`${inputClass} h-10 tabular`} value={v.price} onChange={(e) => set("price", e.target.value.trim())} />
          </Field>
          <Field label="Dispute window" htmlFor="window" error={fields.disputeWindowSeconds} hint="Longer windows earn more trust; shorter ones pay you sooner.">
            <select id="window" className={`${inputClass} h-10`} value={v.disputeWindowSeconds} onChange={(e) => set("disputeWindowSeconds", Number(e.target.value))}>
              {WINDOWS.map(([s, label]) => (
                <option key={s} value={s}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Section>

      <Section title="What you promise" description="Every response is checked against this. Fail a check and the agent is refunded, so promise what you reliably deliver.">
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Respond within" htmlFor="latency" error={fieldError("sla.maxLatencyMs")}>
            <select id="latency" className={`${inputClass} h-10`} value={v.sla.maxLatencyMs} onChange={(e) => setSla("maxLatencyMs", Number(e.target.value))}>
              {LATENCIES.map((ms) => (
                <option key={ms} value={ms}>
                  {ms >= 1000 ? `${ms / 1000} seconds` : `${ms} ms`}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Largest response (KB)" htmlFor="size" error={fieldError("sla.maxResponseBytes")} hint="Up to 5120 KB.">
            <input
              id="size"
              inputMode="numeric"
              className={`${inputClass} h-10 tabular`}
              value={Math.round(v.sla.maxResponseBytes / 1024)}
              onChange={(e) => setSla("maxResponseBytes", Math.max(1, Number(e.target.value.replace(/\D/g, "")) || 0) * 1024)}
            />
          </Field>
          <Field label="Success status codes" htmlFor="statuses" error={statusError ?? fieldError("sla.expectStatus")}>
            <input id="statuses" className={`${inputClass} h-10 font-mono text-[14px]`} value={statusText} onChange={(e) => setStatusText(e.target.value)} />
          </Field>
          <Field label="Content type" htmlFor="ctype" error={fieldError("sla.contentType")}>
            <input id="ctype" className={`${inputClass} h-10 font-mono text-[14px]`} value={v.sla.contentType} onChange={(e) => setSla("contentType", e.target.value.trim())} />
          </Field>
        </div>

        {isJson ? (
          <>
            <Field
              label="Response shape (JSON Schema)"
              htmlFor="schema"
              optional
              error={schema.error ?? fieldError("sla.outputSchema")}
              hint="Regex keywords (pattern) and remote $ref are not allowed."
            >
              <textarea id="schema" rows={8} spellCheck={false} className={`${inputClass} py-2 font-mono text-[13px]`} value={schemaText} onChange={(e) => setSchemaText(e.target.value)} placeholder='{ "type": "object", "required": ["temperature"] }' />
            </Field>
            <details className="rounded-md bg-sunken px-4 py-3">
              <summary className="cursor-pointer text-[15px] font-medium">Generate the schema from a sample response</summary>
              <div className="mt-3 flex flex-col gap-3">
                <textarea aria-label="Sample response" rows={5} spellCheck={false} className={`${inputClass} py-2 font-mono text-[13px]`} value={sample} onChange={(e) => setSample(e.target.value)} placeholder='{ "city": "Lagos", "temperature": 29.5 }' />
                {sampleError && <p className="text-sm text-failed">{sampleError}</p>}
                <div>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      try {
                        setSchemaText(JSON.stringify(inferSchema(JSON.parse(sample)), null, 2));
                        setSampleError(null);
                      } catch (e) {
                        setSampleError(`That sample is not valid JSON: ${(e as Error).message}`);
                      }
                    }}
                  >
                    Use this sample
                  </Button>
                </div>
              </div>
            </details>

            <div className="flex flex-col gap-3">
              <p className="text-sm font-medium">Field rules</p>
              {rows.length === 0 && <p className="text-[15px] text-ink-3">Optional. Rules catch responses that are well-formed but empty or wrong, like a forecast with no temperature.</p>}
              {rows.map((r, i) => {
                const meta = OPS.find((o) => o.op === r.op)!;
                const error = rowErrors[i] ?? fieldError(`sla.assertions.${i}`);
                return (
                  <div key={r.key} className="flex flex-col gap-1.5">
                    <div className="grid gap-2 sm:grid-cols-[1fr_12rem_1fr_auto]">
                      <input aria-label="Field path" className={`${inputClass} h-10 font-mono text-[14px]`} placeholder="/temperature" value={r.path} onChange={(e) => setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, path: e.target.value.trim() } : x)))} />
                      <select aria-label="Rule" className={`${inputClass} h-10`} value={r.op} onChange={(e) => setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, op: e.target.value as Op } : x)))}>
                        {OPS.map((o) => (
                          <option key={o.op} value={o.op}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                      <input aria-label="Value" disabled={!meta.needsValue} className={`${inputClass} h-10 font-mono text-[14px]`} placeholder={meta.placeholder ?? "—"} value={meta.needsValue ? r.value : ""} onChange={(e) => setRows((rs) => rs.map((x) => (x.key === r.key ? { ...x, value: e.target.value } : x)))} />
                      <Button type="button" variant="ghost" size="md" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} aria-label="Remove rule">
                        Remove
                      </Button>
                    </div>
                    {error && <p className="text-sm text-failed">{error}</p>}
                  </div>
                );
              })}
              {rows.length < 20 && (
                <div>
                  <Button type="button" variant="secondary" size="sm" onClick={() => setRows((rs) => [...rs, { key: Date.now(), op: "nonEmpty", path: "", value: "" }])}>
                    Add a rule
                  </Button>
                </div>
              )}
            </div>
          </>
        ) : (
          <p className="text-[15px] text-ink-3">Shape and field rules apply to JSON responses. Other formats are checked for status, time, size and type.</p>
        )}
      </Section>

      <Section title="Accepted input" description="Optional. Requests that do not match are rejected before the agent pays anything.">
        <Field label={v.method === "GET" ? "Query parameters (JSON Schema)" : "Request body (JSON Schema)"} htmlFor="input-schema" optional error={inputSchema.error ?? fieldError("inputSchema")}>
          <textarea id="input-schema" rows={6} spellCheck={false} className={`${inputClass} py-2 font-mono text-[13px]`} value={inputText} onChange={(e) => setInputText(e.target.value)} placeholder='{ "type": "object", "required": ["city"] }' />
        </Field>
      </Section>

      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-6">
        <Button type="submit" size="lg" loading={action.pending} disabled={localInvalid}>
          {editing ? "Save changes" : "Create draft"}
        </Button>
        {!editing && <p className="text-sm text-ink-3">Drafts stay private. Test it, then publish.</p>}
        {localInvalid && <p className="text-sm text-failed">Fix the highlighted fields to continue.</p>}
      </div>
    </form>
  );
}

function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-6 md:grid-cols-[16rem_1fr]" aria-label={title}>
      <div>
        <h2 className="font-medium text-ink">{title}</h2>
        <p className="mt-1 text-sm text-ink-3">{description}</p>
      </div>
      <div className="flex min-w-0 flex-col gap-5">{children}</div>
    </section>
  );
}
