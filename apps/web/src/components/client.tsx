"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { formatDateTime, relative } from "@/lib/format";
import { cx, shortHex } from "./ui";

/** Copies text and confirms visibly for a moment; falls back gracefully where the clipboard is blocked. */
export function CopyButton({ value, label = "Copy", className }: { value: string; label?: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), 1600);
    return () => clearTimeout(t);
  }, [state]);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setState("copied");
        } catch {
          setState("failed");
        }
      }}
      className={cx(
        "inline-flex h-7 items-center rounded-sm px-2 text-xs font-medium transition-colors",
        state === "copied" ? "text-released" : state === "failed" ? "text-failed" : "text-ink-3 hover:bg-sunken hover:text-ink",
        className,
      )}
      aria-live="polite"
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Copy blocked" : label}
    </button>
  );
}

export function Address({ value, href }: { value: string; href?: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" className="font-mono text-[0.92em] text-ink underline decoration-line-strong underline-offset-2 hover:decoration-ink" title={value}>
          {shortHex(value)}
        </a>
      ) : (
        <span className="font-mono text-[0.92em] text-ink" title={value}>
          {shortHex(value)}
        </span>
      )}
      <CopyButton value={value} />
    </span>
  );
}

/** One shared clock for every relative timestamp on the page, ticking every 30s. */
const clock = {
  now: 0, // set on first subscribe, never at module load (that would run during prerendering)
  listeners: new Set<() => void>(),
  timer: undefined as ReturnType<typeof setInterval> | undefined,
  subscribe(listener: () => void) {
    clock.listeners.add(listener);
    if (!clock.timer) {
      clock.now = Date.now();
      clock.timer = setInterval(() => {
        clock.now = Date.now();
        clock.listeners.forEach((l) => l());
      }, 30_000);
    }
    return () => {
      clock.listeners.delete(listener);
      if (clock.listeners.size === 0 && clock.timer) {
        clearInterval(clock.timer);
        clock.timer = undefined;
      }
    };
  },
};

/** Relative time that stays correct while the page is open. The server (and first paint) shows the absolute time. */
export function TimeAgo({ value }: { value: string | Date }) {
  const iso = typeof value === "string" ? value : value.toISOString();
  const now = useSyncExternalStore(
    clock.subscribe,
    () => clock.now,
    () => null,
  );
  return (
    <time dateTime={iso} title={formatDateTime(iso)}>
      {now === null ? formatDateTime(iso) : relative(iso, now)}
    </time>
  );
}
