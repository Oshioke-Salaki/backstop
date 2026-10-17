import type { Metadata } from "next";

export const metadata: Metadata = { title: "Disputes" };

export default function DisputesDoc() {
  return (
    <>
      <h1>Disputes</h1>
      <p>Automatic checks catch broken, slow and malformed responses. Disputes exist for the rest: a response that is well-formed but wrong.</p>
      <h2>Timeline</h2>
      <ol>
        <li><strong>Filing.</strong> The payer, or their agent with the payment link, files during the provider&apos;s dispute window. Funds stay in escrow and the on-chain deadline is extended for review.</li>
        <li><strong>Response.</strong> The provider has 72 hours to answer. If they do not, the payer is refunded automatically.</li>
        <li><strong>Decision.</strong> A Backstop arbiter reads both sides and decides: pay the provider, refund the payer, or split. Fees apply only to the provider&apos;s share.</li>
        <li><strong>Settlement.</strong> The decision is executed on-chain within a minute.</li>
      </ol>
      <h2>Shortcuts</h2>
      <ul>
        <li>The provider can refund at any point while funds are held.</li>
        <li>The payer can withdraw a dispute, which pays the provider.</li>
      </ul>
      <h2>Limits</h2>
      <ul>
        <li>One dispute per payment. A wallet can have five open disputes at a time.</li>
        <li>Services with no dispute window settle as soon as checks pass and cannot be disputed. Their listing says so.</li>
        <li>If an arbiter has not decided by the extended deadline, the payer can reclaim the funds on-chain.</li>
      </ul>
    </>
  );
}
