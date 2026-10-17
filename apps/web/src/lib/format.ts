const dateTime = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

export function formatDateTime(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(d.getTime()) ? "—" : dateTime.format(d);
}

/** "3 hours", "2 days", "45 seconds". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s === 0) return "instantly";
  const units: Array<[number, string]> = [
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
    [1, "second"],
  ];
  for (const [size, name] of units) {
    if (s >= size) {
      const n = Math.round(s / size);
      return `${n} ${name}${n === 1 ? "" : "s"}`;
    }
  }
  return `${s} seconds`;
}

export function relative(target: Date | string, now = Date.now()): string {
  const t = (typeof target === "string" ? new Date(target) : target).getTime();
  const diff = Math.round((t - now) / 1000);
  const abs = Math.abs(diff);
  if (abs < 45) return diff >= 0 ? "in a moment" : "just now";
  const text = formatDuration(abs);
  return diff > 0 ? `in ${text}` : `${text} ago`;
}

export function formatPercent(value: number | null): string {
  if (value === null) return "—";
  const pct = value * 100;
  return `${pct >= 99.95 || pct === 0 ? pct.toFixed(0) : pct.toFixed(1)}%`;
}

export function formatMs(value: number | null): string {
  if (value === null) return "—";
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}s` : `${value}ms`;
}
