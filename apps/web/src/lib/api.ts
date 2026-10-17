"use client";

import { useCallback, useRef, useState } from "react";

export interface ApiFailure {
  code: string;
  message: string;
  status: number;
  /** Field-level problems from validation, keyed by dotted path. */
  fields: Record<string, string>;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiFailure };

const TIMEOUT_MS = 30_000;

/** Same-origin JSON call that never throws: every failure comes back as a readable ApiFailure. */
export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<ApiResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  init.signal?.addEventListener("abort", () => controller.abort());
  try {
    const res = await fetch(path, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: init.body === undefined ? undefined : { "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: "same-origin",
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Non-JSON error page from a proxy or the platform.
    }
    if (res.ok) return { ok: true, data: json as T };
    const err = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    const fields: Record<string, string> = {};
    if (Array.isArray(err?.details)) {
      for (const d of err.details as Array<{ path?: string; message?: string }>) {
        if (d.path && d.message && !fields[d.path]) fields[d.path] = d.message;
      }
    }
    return {
      ok: false,
      error: {
        code: err?.code ?? `http_${res.status}`,
        message: err?.message ?? (res.status >= 500 ? "Something went wrong on our side. Try again." : "That did not work."),
        status: res.status,
        fields,
      },
    };
  } catch (e) {
    const aborted = (e as Error).name === "AbortError";
    return {
      ok: false,
      error: {
        code: aborted ? "timeout" : "network",
        message: aborted ? "The request took too long. Check your connection and try again." : "Could not reach Backstop. Check your connection and try again.",
        status: 0,
        fields: {},
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

export type ActionState<T> =
  | { phase: "idle" }
  | { phase: "pending" }
  | { phase: "success"; data: T }
  | { phase: "error"; error: ApiFailure };

/** Run one mutation at a time, tracking pending/error/success. Ignores stale results. */
export function useAction<Args extends unknown[], T>(fn: (...args: Args) => Promise<ApiResult<T>>) {
  const [state, setState] = useState<ActionState<T>>({ phase: "idle" });
  const seq = useRef(0);
  const run = useCallback(
    async (...args: Args): Promise<ApiResult<T>> => {
      const id = ++seq.current;
      setState({ phase: "pending" });
      const result = await fn(...args);
      if (id === seq.current) setState(result.ok ? { phase: "success", data: result.data } : { phase: "error", error: result.error });
      return result;
    },
    [fn],
  );
  const reset = useCallback(() => setState({ phase: "idle" }), []);
  return { state, run, reset, pending: state.phase === "pending" };
}
