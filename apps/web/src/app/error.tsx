"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui";

export default function ErrorPage({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  const digest = error instanceof Error ? (error as Error & { digest?: string }).digest : undefined;
  const misconfigured = error instanceof Error && /configuration/i.test(error.message);
  return (
    <div className="mx-auto max-w-xl px-4 py-24 sm:px-6" role="alert">
      <h1 className="text-[28px] leading-tight font-medium tracking-tight">{misconfigured ? "Backstop is not configured" : "This page could not load"}</h1>
      <p className="mt-3 text-[15px] text-ink-2">
        {misconfigured
          ? "The server is missing required settings. If you run this deployment, check the environment variables listed in the README."
          : "Something went wrong on our side. Your payments are unaffected: funds in escrow are protected by the contract, not by this page."}
      </p>
      <div className="mt-6 flex items-center gap-4">
        <Button onClick={() => retry()}>Try again</Button>
        {digest && <span className="font-mono text-xs text-ink-3">ref {digest}</span>}
      </div>
    </div>
  );
}
