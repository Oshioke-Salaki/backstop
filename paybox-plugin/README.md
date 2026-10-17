# Backstop PayBox plugin

The PayBox marketplace plugin for Backstop. Built from PayBox plugin starter 1.0.2 (Node 24.21.0, pnpm 11.11.0).

| Tool | Kind | What it does |
| --- | --- | --- |
| `find_protected_services` | read | Search escrow-protected APIs |
| `get_service` | read | A service's promised checks and 30-day delivery/refund record |
| `pay_protected_service` | x402 proposal | Pay one call into Backstop escrow (Base mainnet USDC) |
| `check_payment` | read | Where the money is, from an `x-backstop-payment-url` |
| `dispute_payment` | write | Contest a delivery that passed checks but was wrong |
| `verify_receipt` | read | Verify an `x-backstop-receipt` |

## Build and test

```sh
pnpm install --frozen-lockfile
pnpm test        # typecheck, two identical builds, MCP conformance
```

Upload `dist/plugin.mjs`.

## Portal configuration

- **Network host:** the Backstop host, e.g. `backstop-six-nu.vercel.app`.
- **Environment variable (optional):** `BACKSTOP_URL=https://backstop-six-nu.vercel.app`. Change it, together with the network host, to point the plugin at another deployment without re-uploading.
- **Secrets:** none.

PayBox x402 payments settle on Base mainnet, so `pay_protected_service` needs a Base mainnet Backstop deployment. Against the Base Sepolia deployment it explains that and proposes nothing. Every other tool works on either network.
