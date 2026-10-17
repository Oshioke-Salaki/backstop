/** Demo provider: FX rate. See demo-provider/forecast for why these exist. */
const RATES: Record<string, number> = { "USD/NGN": 1532.4, "EUR/USD": 1.0842, "GBP/USD": 1.2711, "USD/KES": 129.3 };

export function GET(req: Request) {
  const pair = (new URL(req.url).searchParams.get("pair") ?? "USD/NGN").toUpperCase();
  const rate = RATES[pair];
  if (!rate) return Response.json({ error: `unknown pair ${pair}` }, { status: 404 });
  return Response.json({ pair, rate, source: "interbank close" });
}
