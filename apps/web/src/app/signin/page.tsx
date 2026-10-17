import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { SignIn } from "@/components/sign-in";
import { Skeleton } from "@/components/ui";
import { getConfig } from "@/server/config";
import { pageSession } from "@/server/page-session";

export const metadata: Metadata = { title: "Sign in" };

async function SignInPanel({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const [{ next }, session] = await Promise.all([searchParams, pageSession()]);
  const target = next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
  if (session) redirect(target);
  const { network } = getConfig();
  const chainName = network.name === "base" ? "Base" : network.name === "base-sepolia" ? "Base Sepolia" : `chain ${network.chainId}`;
  return <SignIn chainId={network.chainId} chainName={chainName} next={target} />;
}

export default function SignInPage(props: { searchParams: Promise<{ next?: string }> }) {
  return (
    <div className="mx-auto flex max-w-md flex-col px-4 py-16 sm:py-24">
      <h1 className="text-[28px] leading-tight font-medium tracking-tight">Sign in with your wallet</h1>
      <p className="mt-3 text-[15px] text-ink-2">
        Providers manage services and payouts here. Payers can see every payment made from their wallet. Signing in never moves funds.
      </p>
      <div className="mt-8">
        <Suspense fallback={<div className="flex flex-col gap-2"><Skeleton className="h-12" /><Skeleton className="h-12" /></div>}>
          <SignInPanel searchParams={props.searchParams} />
        </Suspense>
      </div>
    </div>
  );
}
