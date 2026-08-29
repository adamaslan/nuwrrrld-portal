"use client";
import { useEffect, useState } from "react";
import { useUser } from "@clerk/nextjs";
import { TOS_URL, PRIVACY_URL } from "@/lib/shared/legal-consent";

/**
 * Wraps the Clerk <SignUp/> widget with a required, unticked express-consent
 * checkbox (Phase 1.4 of docs/todo-auth-cookies-tracking.md — the item first
 * raised in docs/todo1.md).
 *
 * Flow:
 *  - Signed-out + box unchecked → <SignUp/> is not rendered; the user must
 *    agree first. The box is never pre-ticked (not valid consent if it were).
 *  - Box checked → <SignUp/> renders and sign-up proceeds normally.
 *  - Once Clerk reports a session, POST /api/legal-consent to persist the
 *    versioned event. Retries on next mount if the write was lost.
 */
export default function LegalConsentGate({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn } = useUser();
  const [agreed, setAgreed] = useState(false);
  const [recorded, setRecorded] = useState(false);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || recorded) return;
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch("/api/legal-consent");
        const data = await res.json();
        if (data.satisfied) {
          if (!cancelled) setRecorded(true);
          return;
        }
        await fetch("/api/legal-consent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ surface: "web" }),
        });
        if (!cancelled) setRecorded(true);
      } catch {
        // left un-recorded; the next authenticated mount retries
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn, recorded]);

  // A user mid-session (or returning) shouldn't see the gate again.
  if (isSignedIn || agreed) return <>{children}</>;

  return (
    <div style={{ maxWidth: 420, width: "100%" }}>
      <label
        style={{
          display: "flex",
          gap: "0.6rem",
          alignItems: "flex-start",
          fontSize: "0.9rem",
          lineHeight: 1.5,
          marginBottom: "1.25rem",
        }}
      >
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          style={{ marginTop: "0.2rem", flexShrink: 0 }}
        />
        <span>
          I agree to the{" "}
          <a href={TOS_URL} target="_blank" rel="noopener noreferrer">
            Terms of Service
          </a>{" "}
          and{" "}
          <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer">
            Privacy Policy
          </a>
          .
        </span>
      </label>
      <p style={{ fontSize: "0.8rem", opacity: 0.7 }}>
        Check the box above to continue to sign-up.
      </p>
    </div>
  );
}
