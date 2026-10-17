"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, useAction } from "@/lib/api";
import { CopyButton, TimeAgo } from "./client";
import { Button, Field, inputClass, Notice } from "./ui";

/** Shows a secret exactly once and makes the user acknowledge saving it. */
function RevealOnce({ title, value, note, onDone }: { title: string; value: string; note: string; onDone: () => void }) {
  return (
    <div className="flex flex-col gap-3 rounded-md bg-held-soft p-4">
      <p className="font-medium text-held">{title}</p>
      <p className="text-[15px] text-ink-2">{note}</p>
      <div className="flex items-center gap-2 rounded-sm bg-surface px-3 py-2">
        <code className="min-w-0 flex-1 font-mono text-[13px] break-all">{value}</code>
        <CopyButton value={value} />
      </div>
      <div>
        <Button size="sm" onClick={onDone}>
          I saved it
        </Button>
      </div>
    </div>
  );
}

export function OnboardingForm({ address }: { address: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [payout, setPayout] = useState(address);
  const action = useAction((body: Record<string, string>) => api<{ signingSecret: string }>("/api/v1/provider", { body }));
  const fields = action.state.phase === "error" ? action.state.error.fields : {};

  if (action.state.phase === "success") {
    return (
      <RevealOnce
        title="Save your request-signing secret"
        value={action.state.data.signingSecret}
        note="Your API uses this to verify that requests come from Backstop and are paid for. It will not be shown again. You can rotate it later."
        onDone={() => router.refresh()}
      />
    );
  }

  return (
    <form
      className="flex max-w-lg flex-col gap-5"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void action.run({ name, ...(website ? { website } : {}), payoutAddress: payout });
      }}
    >
      {action.state.phase === "error" && !Object.keys(fields).length && <Notice tone="failed" title={action.state.error.message} />}
      <Field label="Provider name" htmlFor="name" error={fields.name} hint="Shown to agents and their users next to every service.">
        <input id="name" className={`${inputClass} h-10`} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required aria-invalid={!!fields.name} />
      </Field>
      <Field label="Website" htmlFor="website" optional error={fields.website}>
        <input id="website" type="url" className={`${inputClass} h-10`} value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://" aria-invalid={!!fields.website} />
      </Field>
      <Field label="Payout address" htmlFor="payout" error={fields.payoutAddress} hint="Released payments go here in USDC. Defaults to the wallet you signed in with.">
        <input id="payout" className={`${inputClass} h-10 font-mono text-[14px]`} value={payout} onChange={(e) => setPayout(e.target.value.trim())} spellCheck={false} aria-invalid={!!fields.payoutAddress} />
      </Field>
      <div>
        <Button type="submit" loading={action.pending} disabled={name.trim().length < 2}>
          Create provider profile
        </Button>
      </div>
    </form>
  );
}

export function ProfileForm({ initial }: { initial: { name: string; website: string | null; payoutAddress: string } }) {
  const router = useRouter();
  const [name, setName] = useState(initial.name);
  const [website, setWebsite] = useState(initial.website ?? "");
  const [payout, setPayout] = useState(initial.payoutAddress);
  const action = useAction((body: Record<string, string>) => api("/api/v1/provider", { method: "PATCH", body }));
  const fields = action.state.phase === "error" ? action.state.error.fields : {};
  const changedPayout = payout.toLowerCase() !== initial.payoutAddress.toLowerCase();
  const dirty = name !== initial.name || website !== (initial.website ?? "") || changedPayout;

  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await action.run({ name, website, payoutAddress: payout });
        if (r.ok) router.refresh();
      }}
    >
      {action.state.phase === "error" && !Object.keys(fields).length && <Notice tone="failed" title={action.state.error.message} />}
      {action.state.phase === "success" && !dirty && <Notice tone="released" title="Saved" />}
      <Field label="Name" htmlFor="p-name" error={fields.name}>
        <input id="p-name" className={`${inputClass} h-10`} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
      </Field>
      <Field label="Website" htmlFor="p-website" optional error={fields.website}>
        <input id="p-website" className={`${inputClass} h-10`} value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://" />
      </Field>
      <Field
        label="Payout address"
        htmlFor="p-payout"
        error={fields.payoutAddress}
        hint={changedPayout ? "New payments pause until this address is approved on-chain (about a minute). Payments already in escrow still go to the old address." : undefined}
      >
        <input id="p-payout" className={`${inputClass} h-10 font-mono text-[14px]`} value={payout} onChange={(e) => setPayout(e.target.value.trim())} spellCheck={false} />
      </Field>
      <div>
        <Button type="submit" variant="secondary" loading={action.pending} disabled={!dirty}>
          Save changes
        </Button>
      </div>
    </form>
  );
}

export function RotateSecret() {
  const [confirming, setConfirming] = useState(false);
  const action = useAction(() => api<{ signingSecret: string }>("/api/v1/provider/secret", { method: "POST", body: {} }));

  if (action.state.phase === "success") {
    return (
      <RevealOnce
        title="New signing secret"
        value={action.state.data.signingSecret}
        note="The old secret stopped working just now. Update your API before the next paid call, or verification on your side will fail."
        onDone={() => {
          action.reset();
          setConfirming(false);
        }}
      />
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {action.state.phase === "error" && <Notice tone="failed" title={action.state.error.message} />}
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[15px] text-ink-2">The current secret stops working immediately.</span>
          <Button variant="danger" size="sm" loading={action.pending} onClick={() => void action.run()}>
            Rotate now
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={action.pending}>
            Cancel
          </Button>
        </div>
      ) : (
        <div>
          <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>
            Rotate signing secret
          </Button>
        </div>
      )}
    </div>
  );
}

interface Key {
  id: string;
  label: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export function ApiKeys({ initial }: { initial: Key[] }) {
  const router = useRouter();
  const [label, setLabel] = useState("");
  const create = useAction((body: { label: string }) => api<{ key: Key & { key: string } }>("/api/v1/provider/keys", { body }));
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const active = initial.filter((k) => !k.revokedAt);

  return (
    <div className="flex flex-col gap-4">
      {create.state.phase === "success" ? (
        <RevealOnce
          title={`Key “${create.state.data.key.label}” created`}
          value={create.state.data.key.key}
          note="Use it as a Bearer token for the provider API. It will not be shown again."
          onDone={() => {
            create.reset();
            setLabel("");
            router.refresh();
          }}
        />
      ) : (
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-start"
          onSubmit={(e) => {
            e.preventDefault();
            void create.run({ label });
          }}
        >
          <div className="flex-1">
            <label htmlFor="key-label" className="sr-only">
              Key name
            </label>
            <input id="key-label" className={`${inputClass} h-10`} placeholder="Name, like “deploy bot”" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} />
            {create.state.phase === "error" && <p className="mt-1.5 text-sm text-failed">{create.state.error.message}</p>}
          </div>
          <Button type="submit" variant="secondary" loading={create.pending} disabled={!label.trim()}>
            Create key
          </Button>
        </form>
      )}
      {revokeError && <Notice tone="failed" title={revokeError} />}
      {active.length === 0 ? (
        <p className="text-[15px] text-ink-3">No active keys. You only need one to manage services from code.</p>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          {active.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="text-[15px] text-ink">{k.label}</p>
                <p className="text-sm text-ink-3">
                  <span className="font-mono">{k.prefix}…</span> · {k.lastUsedAt ? <>used <TimeAgo value={k.lastUsedAt} /></> : "never used"}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                loading={revoking === k.id}
                onClick={async () => {
                  setRevoking(k.id);
                  setRevokeError(null);
                  const r = await api(`/api/v1/provider/keys/${k.id}`, { method: "DELETE" });
                  setRevoking(null);
                  if (!r.ok) setRevokeError(r.error.message);
                  else router.refresh();
                }}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function PayoutPending() {
  return (
    <Notice tone="held" title="Approving your payout address">
      Backstop is registering it with the escrow contract. Services can go live once this finishes, usually within a minute.
    </Notice>
  );
}
