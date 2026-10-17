"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { getAddress, numberToHex } from "viem";
import { createSiweMessage } from "viem/siwe";
import { api } from "@/lib/api";
import { Button, Notice } from "./ui";

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

interface WalletInfo {
  id: string;
  name: string;
  icon?: string;
  provider: Eip1193;
}

/** EIP-6963: every installed wallet announces itself, so users choose instead of whoever grabbed window.ethereum. */
function useWallets(): { wallets: WalletInfo[]; ready: boolean } {
  const [wallets, setWallets] = useState<WalletInfo[]>([]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const found = new Map<string, WalletInfo>();
    const onAnnounce = (e: Event) => {
      const d = (e as CustomEvent<{ info: { uuid: string; name: string; icon: string; rdns: string }; provider: Eip1193 }>).detail;
      if (!d?.info || !d.provider) return;
      found.set(d.info.rdns || d.info.uuid, { id: d.info.rdns || d.info.uuid, name: d.info.name, icon: d.info.icon, provider: d.provider });
      setWallets([...found.values()]);
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    const t = setTimeout(() => {
      const legacy = (window as unknown as { ethereum?: Eip1193 }).ethereum;
      if (found.size === 0 && legacy) setWallets([{ id: "injected", name: "Browser wallet", provider: legacy }]);
      setReady(true);
    }, 400);
    return () => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      clearTimeout(t);
    };
  }, []);
  return { wallets, ready };
}

/** The SIWE message the wallet signs. Valid for ten minutes, bound to this site and network. */
function buildSignInMessage(address: `0x${string}`, chainId: number, nonce: string): string {
  const issuedAt = new Date();
  return createSiweMessage({
    domain: window.location.host,
    address,
    statement: "Sign in to Backstop. This does not move funds or cost gas.",
    uri: window.location.origin,
    version: "1",
    chainId,
    nonce,
    issuedAt,
    expirationTime: new Date(issuedAt.getTime() + 10 * 60_000),
  });
}

type Phase =
  | { step: "choose" }
  | { step: "connecting"; wallet: string }
  | { step: "switching"; wallet: string }
  | { step: "signing"; wallet: string }
  | { step: "verifying"; wallet: string }
  | { step: "done" }
  | { step: "error"; message: string; hint?: string };

function walletError(err: unknown): { message: string; hint?: string } {
  const e = err as { code?: number; message?: string };
  if (e?.code === 4001) return { message: "You cancelled the request in your wallet.", hint: "Nothing was signed. Try again when ready." };
  if (e?.code === -32002) return { message: "Your wallet already has a request open.", hint: "Open your wallet extension and finish or reject it." };
  if (e?.code === 4902) return { message: "Your wallet does not know this network.", hint: "Add the network in your wallet, then try again." };
  return { message: "The wallet did not respond as expected.", hint: e?.message?.slice(0, 140) };
}

export function SignIn({ chainId, chainName, next = "/dashboard" }: { chainId: number; chainName: string; next?: string }) {
  const router = useRouter();
  const { wallets, ready } = useWallets();
  const [phase, setPhase] = useState<Phase>({ step: "choose" });
  const busy = phase.step === "connecting" || phase.step === "switching" || phase.step === "signing" || phase.step === "verifying";
  const safeNext = useMemo(() => (next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard"), [next]);

  async function connect(wallet: WalletInfo) {
    try {
      setPhase({ step: "connecting", wallet: wallet.name });
      const [raw] = (await wallet.provider.request({ method: "eth_requestAccounts" })) as string[];
      if (!raw) throw new Error("No account was shared.");
      const address = getAddress(raw);

      const current = Number(await wallet.provider.request({ method: "eth_chainId" }));
      if (current !== chainId) {
        setPhase({ step: "switching", wallet: wallet.name });
        await wallet.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: numberToHex(chainId) }] });
      }

      const nonce = await api<{ nonce: string }>("/api/auth/nonce");
      if (!nonce.ok) return setPhase({ step: "error", message: nonce.error.message });

      const message = buildSignInMessage(address, chainId, nonce.data.nonce);
      setPhase({ step: "signing", wallet: wallet.name });
      const signature = (await wallet.provider.request({ method: "personal_sign", params: [message, address] })) as string;

      setPhase({ step: "verifying", wallet: wallet.name });
      const verified = await api<{ address: string }>("/api/auth/verify", { body: { message, signature } });
      if (!verified.ok) return setPhase({ step: "error", message: verified.error.message });
      setPhase({ step: "done" });
      router.replace(safeNext);
      router.refresh();
    } catch (err) {
      setPhase({ step: "error", ...walletError(err) });
    }
  }

  const statusText: Record<string, string> = {
    connecting: "Approve the connection in",
    switching: `Switch to ${chainName} in`,
    signing: "Sign the message in",
    verifying: "Checking your signature with",
  };

  return (
    <div className="flex flex-col gap-4">
      {phase.step === "error" && (
        <Notice tone="failed" title={phase.message}>
          {phase.hint}
        </Notice>
      )}
      {phase.step === "done" && <Notice tone="released" title="Signed in. Taking you there…" />}
      {busy && "wallet" in phase && (
        <p className="text-[15px] text-ink-2" role="status" aria-live="polite">
          {statusText[phase.step]} {phase.wallet}…
        </p>
      )}

      {!ready ? (
        <div className="flex flex-col gap-2" aria-label="Looking for wallets" role="status">
          <div className="skeleton h-12" />
          <div className="skeleton h-12" />
        </div>
      ) : wallets.length === 0 ? (
        <Notice title="No wallet found in this browser">
          Install a wallet such as{" "}
          <a className="underline underline-offset-2" href="https://rabby.io" target="_blank" rel="noreferrer">
            Rabby
          </a>{" "}
          or{" "}
          <a className="underline underline-offset-2" href="https://metamask.io" target="_blank" rel="noreferrer">
            MetaMask
          </a>
          , then reload this page. Paying through PayBox? You do not need to sign in: open the payment link your agent gave you.
        </Notice>
      ) : (
        <ul className="flex flex-col gap-2">
          {wallets.map((w) => (
            <li key={w.id}>
              <Button variant="secondary" size="lg" className="w-full justify-start" disabled={busy} loading={busy && "wallet" in phase && phase.wallet === w.name} onClick={() => connect(w)}>
                {/* EIP-6963 icons are data: URIs supplied by the wallet; next/image cannot optimise them. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {w.icon && !busy ? <img src={w.icon} alt="" className="size-5 rounded-sm" /> : null}
                Continue with {w.name}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      loading={pending}
      onClick={async () => {
        setPending(true);
        await api("/api/auth/logout", { method: "POST", body: {} });
        router.replace("/");
        router.refresh();
      }}
    >
      Sign out
    </Button>
  );
}
