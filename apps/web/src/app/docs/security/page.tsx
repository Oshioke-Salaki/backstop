import type { Metadata } from "next";

export const metadata: Metadata = { title: "How funds are protected" };

export default function SecurityDoc() {
  return (
    <>
      <h1>How funds are protected</h1>
      <p>Backstop&apos;s servers decide <em>when</em> money moves. The escrow contract decides <em>where</em> it can go. These rules are enforced on-chain:</p>
      <h2>Contract guarantees</h2>
      <ul>
        <li><strong>Two destinations.</strong> Held funds can go only to the payer, or to the provider address recorded at deposit.</li>
        <li><strong>Payer reclaim.</strong> Each escrow has a deadline. After it, anyone can call <code>reclaim</code> and the funds go to the payer. No Backstop key is involved.</li>
        <li><strong>Bounded holds.</strong> Deadlines can be extended for disputes, but never past 30 days from deposit.</li>
        <li><strong>No owner access.</strong> The owner configures operators, fees and limits. There is no function that sends held funds anywhere else. Stray tokens can be rescued only above the amount held.</li>
        <li><strong>Pause is one-way safe.</strong> Pausing blocks new deposits. Refunds and reclaims always work.</li>
        <li><strong>Fees.</strong> Locked at deposit, capped at 5% in the contract, never charged on refunds.</li>
        <li><strong>Exact amounts.</strong> Deposits revert unless the contract receives exactly the authorized amount.</li>
      </ul>
      <h2>Keys</h2>
      <p>Backstop separates duties across keys, so one leaked key cannot do much:</p>
      <table>
        <thead><tr><th>Key</th><th>Can</th><th>Cannot</th></tr></thead>
        <tbody>
          <tr><td>Depositor</td><td>Pull signed payments into escrow</td><td>Release, or approve payees</td></tr>
          <tr><td>Settler</td><td>Release, refund, split, extend</td><td>Send funds anywhere but payer or bound payee</td></tr>
          <tr><td>Registrar</td><td>Approve provider payout addresses</td><td>Move funds</td></tr>
          <tr><td>Owner (multisig)</td><td>Set operators, fees, limits; pause</td><td>Touch held funds</td></tr>
          <tr><td>Receipt signer</td><td>Sign delivery verdicts</td><td>Anything on-chain</td></tr>
        </tbody>
      </table>
      <h2>Off-chain safeguards</h2>
      <ul>
        <li>Provider URLs are restricted to public internet addresses, checked again at connection time, and redirects are never followed.</li>
        <li>Provider schemas cannot use regular expressions or remote references, so verification cannot be stalled.</li>
        <li>Stored responses and provider secrets are encrypted at rest (AES-256-GCM).</li>
        <li>A reconciler compares every held payment with the chain and corrects any drift, including payments interrupted by a crash.</li>
      </ul>
    </>
  );
}
