import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "For agents" };

export default function AgentsDoc() {
  return (
    <>
      <h1>For agents</h1>
      <p>A Backstop service is an ordinary x402 resource. Any x402 client can pay it. The difference is where the money goes and what happens if the provider fails.</p>

      <h2>Paying with PayBox</h2>
      <ol>
        <li>Find a service with PayBox <code>discover_services</code>, the Backstop MCP tool <code>search_services</code>, or <Link href="/services">the directory</Link>.</li>
        <li>Call it. You get <code>402</code> with terms in both x402 v1 (JSON body) and v2 (<code>PAYMENT-REQUIRED</code> header). <code>payTo</code> is the escrow contract.</li>
        <li>Pay with <code>pay_x402</code> (or <code>use_service</code> in gateway mode). The signature authorizes a transfer to the escrow only.</li>
        <li>Retry the same request with the <code>X-PAYMENT</code> (v1) or <code>PAYMENT-SIGNATURE</code> (v2) header.</li>
      </ol>
      <pre><code>{`paybox pay-x402 --url "https://<backstop-host>/x/skyline-forecast?city=Lagos"`}</code></pre>

      <h2>What comes back</h2>
      <table>
        <thead><tr><th>Outcome</th><th>Status</th><th>Meaning</th></tr></thead>
        <tbody>
          <tr><td>Delivered</td><td><code>2xx</code></td><td>The provider&apos;s response, unchanged. Funds release after the dispute window.</td></tr>
          <tr><td>Not delivered</td><td><code>502</code></td><td><code>delivery_failed</code> with the failed check. A full refund is already queued. The bad body is withheld.</td></tr>
          <tr><td>Bad input</td><td><code>400</code></td><td>The request did not match the service&apos;s input schema. You were not charged.</td></tr>
          <tr><td>Payment rejected</td><td><code>402</code></td><td><code>code</code> says why: wrong amount, expired, insufficient funds and so on. Nothing was charged.</td></tr>
          <tr><td>Retry in progress</td><td><code>409</code></td><td><code>payment_in_progress</code>: the same payment is still being handled. Retry shortly.</td></tr>
          <tr><td>Payment reused</td><td><code>409</code></td><td><code>payment_reused</code>: that authorization already paid for a different request.</td></tr>
        </tbody>
      </table>
      <p>Every paid response includes these headers:</p>
      <ul>
        <li><code>x-backstop-escrow-id</code>: the on-chain escrow id.</li>
        <li><code>x-backstop-status</code>: where the payment stands now.</li>
        <li><code>x-backstop-receipt</code>: a signed verdict you can <Link href="/verify">verify</Link> offline.</li>
        <li><code>x-backstop-payment-url</code>: a private link to the payment, for you or your user. Keep it: it is also the token for disputes.</li>
      </ul>

      <h2>Retries are safe</h2>
      <p>
        Sending the same payment header for the same request again returns the original outcome and never charges twice. If you lose the response to a delivered call,
        retrying returns the stored copy while it is retained.
      </p>

      <h2>MCP server</h2>
      <p>Add <code>https://&lt;backstop-host&gt;/api/mcp</code> as a remote MCP server (streamable HTTP, no sign-in). Tools:</p>
      <ul>
        <li><code>search_services</code>, <code>get_service</code>: find services and read their terms and track record.</li>
        <li><code>get_payment</code>: status of a payment, from the escrow id and token in its payment link.</li>
        <li><code>open_dispute</code>, <code>withdraw_dispute</code>: contest a delivery that passed checks but was wrong. Ask your user first.</li>
        <li><code>verify_receipt</code>: check a receipt header.</li>
      </ul>
    </>
  );
}
