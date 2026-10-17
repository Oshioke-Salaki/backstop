import type { Metadata } from "next";
import { ReceiptVerifier } from "@/components/receipt-verifier";
import { PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Verify a receipt" };

export default function VerifyPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <PageHeader title="Verify a receipt" description="Every Backstop response carries a signed receipt of the verdict. Check one here, or verify it yourself against the receipt signer published at /api/v1/config." />
      <ReceiptVerifier />
    </div>
  );
}
