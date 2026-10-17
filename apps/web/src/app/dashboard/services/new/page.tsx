import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { DEFAULT_VALUES, ServiceForm } from "@/components/service-form";
import { PageHeader, Skeleton } from "@/components/ui";
import { pageSession } from "@/server/page-session";
import { getProviderForOwner } from "@/server/providers";

export const metadata: Metadata = { title: "New service" };

async function Gate() {
  const session = await pageSession();
  if (!session) redirect("/signin?next=/dashboard/services/new");
  if (!(await getProviderForOwner(session.address))) redirect("/dashboard");
  return <ServiceForm initial={DEFAULT_VALUES} />;
}

export default function NewServicePage() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
      <PageHeader title="New service" description="Describe one endpoint: what it costs and what every response promises." back={{ href: "/dashboard", label: "Dashboard" }} />
      <Suspense fallback={<div className="flex flex-col gap-4"><Skeleton className="h-10" /><Skeleton className="h-10" /><Skeleton className="h-24" /></div>}>
        <Gate />
      </Suspense>
    </div>
  );
}
