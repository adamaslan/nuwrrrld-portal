"use client";

/**
 * Client island for the Beta testers panel: a grant form and per-row revoke.
 * Holds no secrets and does no auth — every decision is in the Server Actions
 * (lib/nulogdash-beta-actions.ts).
 */
import { useState, useTransition } from "react";
import { grantBeta, revokeBeta, revokePendingBeta, type BetaActionResult } from "@/lib/nulogdash-beta-actions";

function ResultLine({ result }: { result: BetaActionResult | null }) {
  if (!result) return null;
  return (
    <p role="status" className={result.ok ? "nld-result nld-result--ok" : "nld-result nld-result--err"}>
      {result.ok ? result.message : result.error}
      {result.ok && result.signupUrl && <><br /><a href={result.signupUrl} style={{ textDecoration: "underline", overflowWrap: "anywhere" }}>Signup link (no access token)</a><br />This link only opens signup. Beta requires a verified primary email added by an admin.</>}
    </p>
  );
}

export function GrantForm({ canMutate }: { canMutate: boolean }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<BetaActionResult | null>(null);
  const [email, setEmail] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [note, setNote] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setResult(null);
    startTransition(async () => {
      try {
        const r = await grantBeta({ email, expiresAt, note });
        setResult(r);
        if (r.ok) {
          setEmail("");
          setExpiresAt("");
          setNote("");
        }
      } catch (err) {
        setResult({ ok: false, error: err instanceof Error ? err.message : "Grant failed." });
      }
    });
  }

  return (
    <form className="nld-beta-form" onSubmit={submit}>
      <label>
        Email
        <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
      </label>
      <details>
      <summary>Optional expiry and note</summary>
      <label>
        Expires (optional)
        <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
      </label>
      <label>
        Note (optional)
        <input type="text" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      </details>
      <button type="submit" className="nld-trigger-btn" disabled={pending || !canMutate}>
        {pending ? "Adding…" : "Add to beta"}
      </button>
      <ResultLine result={result} />
    </form>
  );
}

export function RevokeButton({ userId, canMutate }: { userId: string; canMutate: boolean }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<BetaActionResult | null>(null);

  function revoke() {
    startTransition(async () => {
      try {
        setResult(await revokeBeta({ userId }));
      } catch (err) {
        setResult({ ok: false, error: err instanceof Error ? err.message : "Revoke failed." });
      }
    });
  }

  return (
    <>
      <button type="button" className="nld-trigger-btn" onClick={revoke} disabled={pending || !canMutate}>
        {pending ? "Revoking…" : "Revoke"}
      </button>
      <ResultLine result={result} />
    </>
  );
}

export function RevokePendingButton({ emailId, canMutate }: { emailId: string; canMutate: boolean }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<BetaActionResult | null>(null);
  return <>
    <button type="button" className="nld-trigger-btn" disabled={pending || !canMutate}
      onClick={() => startTransition(async () => {
        try { setResult(await revokePendingBeta({ emailId })); }
        catch { setResult({ ok: false, error: "Could not revoke email grant. Try again." }); }
      })}>{pending ? "Revoking…" : "Revoke email grant"}</button>
    <ResultLine result={result} />
  </>;
}
