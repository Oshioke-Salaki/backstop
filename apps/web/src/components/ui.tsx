import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { STATUS, TONE_CLASSES, type Tone } from "@/lib/status";
import type { EscrowStatus } from "@backstop/core";

export function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

// --- Buttons -----------------------------------------------------------------

type Variant = "primary" | "secondary" | "ghost" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-ink hover:opacity-90 active:opacity-80",
  secondary: "bg-surface text-ink border border-line-strong hover:bg-sunken",
  ghost: "text-ink-2 hover:text-ink hover:bg-sunken",
  danger: "bg-failed text-white hover:opacity-90 active:opacity-80",
};

const SIZES = {
  sm: "h-8 px-3 text-sm gap-1.5",
  md: "h-10 px-4 text-[15px] gap-2",
  lg: "h-12 px-5 text-base gap-2",
};

export function buttonClass(variant: Variant = "primary", size: keyof typeof SIZES = "md", extra?: string) {
  return cx(
    "inline-flex items-center justify-center rounded-md font-medium whitespace-nowrap select-none",
    "transition-[opacity,background-color,color] duration-150 disabled:cursor-not-allowed disabled:opacity-50",
    VARIANTS[variant],
    SIZES[size],
    extra,
  );
}

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  className,
  children,
  disabled,
  ...rest
}: ComponentProps<"button"> & { variant?: Variant; size?: keyof typeof SIZES; loading?: boolean }) {
  return (
    <button {...rest} disabled={disabled || loading} aria-busy={loading || undefined} className={buttonClass(variant, size, className)}>
      {loading && <Spinner />}
      {children}
    </button>
  );
}

export function ButtonLink({ variant = "primary", size = "md", className, ...rest }: ComponentProps<typeof Link> & { variant?: Variant; size?: keyof typeof SIZES }) {
  return <Link {...rest} className={buttonClass(variant, size, className)} />;
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cx("size-4 animate-spin", className)} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

// --- Form fields ---------------------------------------------------------------

export const inputClass = cx(
  "w-full rounded-md border border-line-strong bg-surface px-3 text-[15px] text-ink placeholder:text-ink-3",
  "transition-colors focus:border-accent focus:outline-none aria-[invalid=true]:border-failed",
  "disabled:cursor-not-allowed disabled:opacity-60",
);

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
  optional,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  htmlFor: string;
  children: ReactNode;
  optional?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium text-ink">
        {label}
        {optional && <span className="ml-1.5 font-normal text-ink-3">optional</span>}
      </label>
      {children}
      {error ? (
        <p id={`${htmlFor}-error`} role="alert" className="text-sm text-failed">
          {error}
        </p>
      ) : hint ? (
        <p id={`${htmlFor}-hint`} className="text-sm text-ink-3">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

// --- Status --------------------------------------------------------------------

export function StatusMark({ status, size = "md" }: { status: EscrowStatus; size?: "md" | "lg" }) {
  const meta = STATUS[status];
  const tone = TONE_CLASSES[meta.tone];
  return (
    <span className={cx("inline-flex items-center gap-2 font-medium", tone.text, size === "lg" ? "text-base" : "text-sm")}>
      <span className={cx("inline-block size-2 shrink-0 rounded-full", tone.dot, meta.live && "animate-pulse-dot")} aria-hidden="true" />
      {meta.label}
    </span>
  );
}

export function Notice({ tone = "neutral", title, children, action }: { tone?: Tone; title?: string; children?: ReactNode; action?: ReactNode }) {
  const t = TONE_CLASSES[tone];
  return (
    <div className={cx("flex flex-col gap-3 rounded-md px-4 py-3 sm:flex-row sm:items-center sm:justify-between", t.soft)} role={tone === "failed" ? "alert" : "status"}>
      <div className="min-w-0">
        {title && <p className={cx("font-medium", t.text)}>{title}</p>}
        {children && <div className="text-[15px] text-ink-2">{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

// --- Layout pieces ---------------------------------------------------------------

export function Panel({ children, className, as: As = "section" }: { children: ReactNode; className?: string; as?: "section" | "div" | "article" }) {
  return <As className={cx("rounded-lg border border-line bg-surface", className)}>{children}</As>;
}

export function PanelHeader({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
      <div className="min-w-0">
        <h2 className="font-medium text-ink">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-ink-3">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm text-ink-3">{label}</span>
      <span className="tabular text-2xl font-medium text-ink">{value}</span>
      {sub && <span className="text-sm text-ink-3">{sub}</span>}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3 px-5 py-10 sm:items-center sm:text-center">
      <p className="font-medium text-ink">{title}</p>
      {children && <div className="max-w-md text-[15px] text-ink-3">{children}</div>}
      {action}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("skeleton", className)} aria-hidden="true" />;
}

export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-3 p-5" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-5" />
      ))}
    </div>
  );
}

export function PageHeader({ title, description, action, back }: { title: string; description?: ReactNode; action?: ReactNode; back?: { href: string; label: string } }) {
  return (
    <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {back && (
          <Link href={back.href} className="mb-3 inline-block text-sm text-ink-3 hover:text-ink">
            ← {back.label}
          </Link>
        )}
        <h1 className="text-[28px] leading-tight font-medium tracking-tight text-ink sm:text-[32px]">{title}</h1>
        {description && <p className="mt-2 max-w-2xl text-[15px] text-ink-2">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </header>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("font-mono text-[0.92em]", className)}>{children}</span>;
}

export function shortHex(value: string, head = 6, tail = 4) {
  return value.length <= head + tail + 2 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}
