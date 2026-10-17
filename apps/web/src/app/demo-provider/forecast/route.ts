/**
 * Demo provider APIs. These stand in for a third-party provider so the hosted demo has public https
 * upstreams. Backstop calls them like any other provider; they are not part of the product.
 */
export function GET(req: Request) {
  const city = new URL(req.url).searchParams.get("city")?.slice(0, 60) || "Lagos";
  const seed = [...city].reduce((n, c) => n + c.charCodeAt(0), 0);
  return Response.json({
    city,
    temperature: Math.round((18 + (seed % 170) / 10) * 10) / 10,
    conditions: ["Clear", "Humid, scattered showers", "Overcast", "Light breeze"][seed % 4],
    updatedAt: new Date().toISOString(),
  });
}
