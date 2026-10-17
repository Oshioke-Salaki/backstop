import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "For providers" };

export default function ProvidersDoc() {
  return (
    <>
      <h1>For providers</h1>
      <p>You keep your API exactly as it is. Backstop sits in front of it, takes payment into escrow, and calls you only once the money is locked.</p>

      <h2>Getting listed</h2>
      <ol>
        <li><Link href="/signin">Sign in</Link> with a wallet and create a provider profile. Save the request-signing secret shown once.</li>
        <li>Your payout address is approved in the escrow contract automatically.</li>
        <li>Create a service: your API&apos;s URL, a price, a dispute window, and what every response promises.</li>
        <li>Run a test call from the dashboard. It hits your live API and shows exactly what Backstop would decide, for free.</li>
        <li>Publish. Agents can now pay <code>/x/&lt;your-service&gt;</code>.</li>
      </ol>

      <h2>Writing a promise you will keep</h2>
      <p>Every response is checked against your SLA, in order, stopping at the first miss:</p>
      <ol>
        <li>It arrived within your latency limit (the call is cut off at that point).</li>
        <li>The status is one you listed, and it is not a <code>402</code>.</li>
        <li>It is no larger than your size cap.</li>
        <li>The content type matches.</li>
        <li>For JSON: it parses, matches your JSON Schema, and passes your field rules.</li>
      </ol>
      <p>Promise what you reliably deliver. A tight latency limit that you sometimes miss turns into refunds. Field rules are the best way to catch &quot;valid but empty&quot; responses before your users do.</p>

      <h2>Verifying requests come from Backstop</h2>
      <p>Each call carries <code>x-backstop-escrow-id</code>, <code>x-backstop-payer</code> and <code>x-backstop-signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</code>, where</p>
      <pre><code>{`v1 = HMAC_SHA256(secret, \`\${t}.\${escrowId}.\${METHOD}.\${pathWithQuery}.\${sha256hex(body)}\`)
// sha256hex is "0x" + lowercase hex of the raw request body (empty body included)`}</code></pre>
      <pre><code>{`import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function isFromBackstop(req, rawBody, secret) {
  const sig = req.headers["x-backstop-signature"] ?? "";
  const { t, v1 } = Object.fromEntries(sig.split(",").map((p) => p.split("=")));
  if (!t || !v1 || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const digest = "0x" + createHash("sha256").update(rawBody).digest("hex");
  const payload = [t, req.headers["x-backstop-escrow-id"], req.method, req.url, digest].join(".");
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  return v1.length === expected.length && timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
}`}</code></pre>
      <p>Test calls from the dashboard also send <code>x-backstop-dry-run: 1</code>. They are not paid for.</p>

      <h2>Getting paid</h2>
      <p>
        Passing calls release to your payout address when the dispute window closes, minus a 1% fee. With no dispute window they release within seconds. If a payer
        disputes, the funds stay in escrow until you respond and an arbiter decides, or until you choose to refund. You can always refund a held payment yourself.
      </p>
      <h2>Changing things later</h2>
      <ul>
        <li>Price and SLA changes apply to new calls only.</li>
        <li>A service&apos;s URL name is locked once it has been paid for, because agents depend on it.</li>
        <li>Changing your payout address pauses new payments for about a minute while it is approved. Payments already in escrow go to the old address.</li>
      </ul>
    </>
  );
}
