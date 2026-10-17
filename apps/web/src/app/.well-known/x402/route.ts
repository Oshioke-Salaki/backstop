import { json, route } from "@/server/http";
import { listPublicServices } from "@/server/services";

/** Machine-readable list of paid resources, for x402 crawlers and catalogs. */
export const GET = route(async () => {
  const services = await listPublicServices({ limit: 200 });
  return json({
    x402Version: 1,
    resources: services
      .filter((s) => s.status === "active")
      .map((s) => ({
        resource: s.resource,
        method: s.method,
        name: s.name,
        description: s.description,
        price: { amount: s.priceAtomic, asset: "USDC", decimals: 6 },
        protected: true,
        disputeWindowSeconds: s.disputeWindowSeconds,
        provider: s.provider.name,
      })),
  });
});
