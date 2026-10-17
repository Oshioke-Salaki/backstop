/** Demo provider: one-line summary. See demo-provider/forecast for why these exist. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { text?: unknown };
  const text = typeof body.text === "string" ? body.text.slice(0, 40_000) : "";
  const words = text.split(/\s+/).filter(Boolean);
  return Response.json({ summary: words.slice(0, 14).join(" ") + (words.length > 14 ? "…" : ""), words: words.length });
}
