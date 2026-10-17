import type { Metadata } from "next";

export const metadata: Metadata = { title: "API reference" };

const ROUTES: Array<[string, string, string, string]> = [
  ["GET/POST", "/x/:service/*", "x402", "Protected call. 402 without payment; see the agent guide."],
  ["GET", "/.well-known/x402", "public", "Machine-readable list of active resources."],
  ["GET", "/api/v1/services?q=", "public", "Search listed services."],
  ["GET", "/api/v1/services/:slug", "public", "One service with its 30-day record."],
  ["GET", "/api/v1/config", "public", "Network, escrow, asset and receipt signer."],
  ["POST", "/api/v1/receipts/verify", "public", "Verify a receipt (header or JSON)."],
  ["POST", "/api/mcp", "public", "MCP server (JSON-RPC over HTTP)."],
  ["GET", "/api/v1/payments/:id", "token or session", "Payment status, timeline and allowed actions."],
  ["POST", "/api/v1/payments/:id/dispute", "payer", "Open a dispute: { reason, statement }."],
  ["POST", "/api/v1/payments/:id/withdraw", "payer", "Withdraw an open dispute."],
  ["POST", "/api/v1/payments/:id/respond", "provider", "Answer a dispute: { statement }."],
  ["POST", "/api/v1/payments/:id/refund", "provider", "Refund a held payment in full."],
  ["POST", "/api/v1/payments/:id/resolve", "arbiter", "Decide: release, refund or split."],
  ["GET/POST/PATCH", "/api/v1/provider", "session (key for GET/PATCH)", "Provider profile."],
  ["GET/POST", "/api/v1/provider/services", "session or key", "List or create services."],
  ["GET/PUT/DELETE", "/api/v1/provider/services/:id", "session or key", "Read, update, delete (drafts without payments)."],
  ["POST", "/api/v1/provider/services/:id/status", "session or key", "{ status: active | paused }."],
  ["POST", "/api/v1/provider/services/:id/test", "session or key", "Dry-run against your upstream."],
  ["GET", "/api/v1/provider/payments", "session or key", "Payments to you. ?status=a,b&cursor="],
  ["GET", "/api/v1/payer/payments", "session", "Payments from your wallet."],
  ["GET/POST", "/api/v1/provider/keys", "session", "List or create API keys."],
  ["POST", "/api/v1/provider/secret", "session", "Rotate the request-signing secret."],
];

export default function ApiDoc() {
  return (
    <>
      <h1>API reference</h1>
      <p>
        JSON in, JSON out. Errors always look like <code>{`{ "error": { "code", "message", "details"? } }`}</code>; <code>details</code> lists field problems on validation
        errors. Provider endpoints accept a session cookie or <code>Authorization: Bearer bsk_…</code>. Payment endpoints accept the token from a payment link as
        <code>?t=</code> or <code>x-backstop-token</code>.
      </p>
      <div className="overflow-x-auto">
        <table>
          <thead><tr><th>Method</th><th>Path</th><th>Auth</th><th>Purpose</th></tr></thead>
          <tbody>
            {ROUTES.map(([m, p, a, d]) => (
              <tr key={`${m}${p}`}><td><code>{m}</code></td><td><code>{p}</code></td><td>{a}</td><td>{d}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2>Rate limits</h2>
      <p>Requests over the limit get <code>429</code> with <code>Retry-After</code>. Limits are per wallet for payments and per client for everything else.</p>
    </>
  );
}
