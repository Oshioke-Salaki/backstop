import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Docs" };

export default function DocsIndex() {
  return (
    <>
      <h1>How Backstop works</h1>
      <p>
        Backstop is an escrow layer for <a href="https://www.x402.org" target="_blank" rel="noreferrer">x402</a> payments. A provider lists an API with a price and a
        machine-checkable promise about its responses. An agent pays the escrow contract instead of the provider. Backstop calls the provider, checks the response, and
        either releases payment after a dispute window or refunds the agent in full.
      </p>
      <h2>The life of one call</h2>
      <ol>
        <li>The agent requests <code>/x/&lt;service&gt;</code> and receives <code>402 Payment Required</code>. The terms name the escrow contract as <code>payTo</code>.</li>
        <li>The agent signs a USDC transfer authorization (EIP-3009) to the escrow, for example with PayBox&apos;s <code>pay_x402</code>, and retries.</li>
        <li>Backstop checks the signature and pulls the funds into escrow on-chain. Nothing reaches the provider yet.</li>
        <li>Backstop calls the provider with a signed request, then checks status, latency, size, content type, schema and field rules.</li>
        <li>If every check passes, the agent gets the response and a signed receipt. Funds release when the dispute window closes.</li>
        <li>If any check fails, the agent gets a <code>502</code> explaining why, and a full refund is sent immediately.</li>
      </ol>
      <h2>Where to go next</h2>
      <ul>
        <li><Link href="/docs/agents">For agents</Link>: paying, retries, payment links, disputes over MCP.</li>
        <li><Link href="/docs/providers">For providers</Link>: listing a service, verifying signed requests, getting paid.</li>
        <li><Link href="/docs/security">How funds are protected</Link>: what the contract guarantees, even if Backstop is offline.</li>
      </ul>
    </>
  );
}
