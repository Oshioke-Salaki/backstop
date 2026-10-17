/** Demo provider that deliberately breaks its promise (no headlines), to show automatic refunds. */
export function GET() {
  return Response.json({ error: "feed temporarily unavailable" });
}
