"use client";

/** Client island for the Beta testers tab: grant form + per-row revoke.
 * Holds no auth or secrets; every decision is in lib/beta-grant-actions. */
import { useState, useTransition } from "react";
import { grantBeta, revokeBeta, type BetaActionResult } from "@/lib/beta-grant-actions";

export function GrantForm() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<BetaActionResult | null>(null);
  const [email, setEmail] = useState("");
  const [days, setDays] = useState("90");
  const [note, setNote] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const expiresInDays = days.trim() === "" ? null : Number(days);
    startTransition(async () => {
      const r = await grantBeta({ email, expiresInDays, note });
      setResult(r);
      if (r.ok) setEmail("");
    });
  }

  return (
    <form onSubmit={submit} className="nld-trigger-confirm">
      <input type="email" required placeholder="tester email" value={email}
        onChange={(e) => setEmail(e.target.value)} aria-label="Tester email" />
      <input type="number" min={1} placeholder="days (blank = none)" value={days}
        onChange={(e) => setDays(e.target.value)} aria-label="Expiry in days" />
      <input type="text" maxLength={120} placeholder="note (e.g. fall 2026 cohort)" value={note}
        onChange={(e) => setNote(e.target.value)} aria-label="Note" />
      <button type="submit" className="nld-trigger-btn" disabled={pending}>
        {pending ? "Granting…" : "Grant Pro"}
      </button>
      {result && <span role="status">{result.ok ? result.message : result.error}</span>}
    </form>
  );
}

export function RevokeButton({ userId }: { userId: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <button type="button" className="nld-trigger-btn" disabled={pending}
      onClick={() => startTransition(async () => { await revokeBeta({ userId }); })}>
      {pending ? "Revoking…" : "Revoke"}
    </button>
  );
}
