import Link from "next/link";
import { buttonClass } from "@/components/ui";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-xl px-4 py-24 sm:px-6">
      <h1 className="text-[28px] leading-tight font-medium tracking-tight">Nothing here</h1>
      <p className="mt-3 text-[15px] text-ink-2">The page may have moved, or the link is incomplete. Payment links need the full address, including the part after <span className="font-mono">?t=</span>.</p>
      <div className="mt-6 flex gap-3">
        <Link href="/" className={buttonClass("primary")}>Go home</Link>
        <Link href="/services" className={buttonClass("ghost")}>Browse services</Link>
      </div>
    </div>
  );
}
