import Link from "next/link";
import type { PaymentRow } from "@/server/payments";
import { FAILURE_LABELS } from "@/lib/status";
import { TimeAgo } from "./client";
import { shortHex, StatusMark } from "./ui";

export function PaymentsTable({ items, showPayer = true }: { items: PaymentRow[]; showPayer?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] text-left text-[15px]">
        <thead className="text-sm text-ink-3">
          <tr className="border-b border-line">
            <th className="px-5 py-2.5 font-normal">Status</th>
            <th className="px-5 py-2.5 font-normal">Service</th>
            {showPayer && <th className="px-5 py-2.5 font-normal">Payer</th>}
            <th className="px-5 py-2.5 text-right font-normal">Amount</th>
            <th className="px-5 py-2.5 text-right font-normal">When</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {items.map((p) => (
            <tr key={p.id} className="group hover:bg-sunken">
              <td className="px-5 py-3">
                <Link href={`/p/${p.id}`} className="block">
                  <StatusMark status={p.status} />
                  {p.reason && <span className="mt-0.5 block text-sm text-ink-3">{FAILURE_LABELS[p.reason] ?? p.reason}</span>}
                </Link>
              </td>
              <td className="px-5 py-3">
                <Link href={`/p/${p.id}`} className="text-ink">{p.serviceName}</Link>
              </td>
              {showPayer && <td className="px-5 py-3 font-mono text-[13px] text-ink-2">{shortHex(p.payer)}</td>}
              <td className="tabular px-5 py-3 text-right">{p.amount}</td>
              <td className="px-5 py-3 text-right text-ink-3"><TimeAgo value={p.createdAt} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
