import Link from "next/link";

export function Logo({ className = "" }: { className?: string }) {
  return (
    <Link href="/" className={`inline-flex items-center gap-2 text-ink ${className}`} aria-label="Backstop home">
      <svg viewBox="0 0 20 20" className="size-5" aria-hidden="true">
        <rect x="2" y="2" width="16" height="16" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
        <rect x="6" y="10" width="8" height="4" rx="1" fill="var(--accent)" />
      </svg>
      <span className="text-[17px] font-semibold tracking-tight">Backstop</span>
    </Link>
  );
}
