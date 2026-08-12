"use client";
import { useEffect, useState } from "react";
import { useUser } from "@clerk/nextjs";
import "./disclaimer.css";
import {
  DISCLAIMER_TEXT,
  DISCLAIMER_VERSION,
  DISCLAIMER_LAST_UPDATED,
  hasAcknowledgedLocally,
  markAcknowledgedLocally,
} from "@/lib/disclaimer";

interface Props {
  /** Which trade-shaped surface is gating on this — recorded with the ack for audit. */
  surface: "verdict" | "signals" | "portfolio" | "analyze";
  /** Viewer mode: always open, dismissible, no gating — used by DisclaimerFooter's
   *  "View full disclaimer" link so re-reading the text never clears an ack. */
  forceOpen?: boolean;
  onRequestClose?: () => void;
}

export default function DisclaimerModal({ surface, forceOpen = false, onRequestClose }: Props) {
  const { isSignedIn, isLoaded } = useUser();
  const [open, setOpen] = useState(forceOpen);
  const [checked, setChecked] = useState(forceOpen);

  useEffect(() => {
    if (forceOpen) return;
    // Wait for Clerk: isSignedIn is undefined until isLoaded, which would
    // otherwise read as "not signed in" and open the modal prematurely.
    if (!isLoaded) return;

    let cancelled = false;

    async function check() {
      if (hasAcknowledgedLocally()) {
        if (!cancelled) { setChecked(true); setOpen(false); }
        return;
      }
      if (isSignedIn) {
        try {
          const res = await fetch("/api/disclaimer");
          const data = await res.json();
          if (data.acknowledged) {
            markAcknowledgedLocally();
            if (!cancelled) { setChecked(true); setOpen(false); }
            return;
          }
        } catch {
          // fall through to showing the modal — failing closed
        }
      }
      if (!cancelled) {
        setOpen(true);
        setChecked(true);
      }
    }

    check();
    return () => { cancelled = true; };
  }, [forceOpen, isSignedIn, isLoaded]);

  async function accept() {
    markAcknowledgedLocally();
    if (isSignedIn) {
      fetch("/api/disclaimer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ surface }),
      }).catch(() => {});
    }
    setOpen(false);
    onRequestClose?.();
  }

  function dismiss() {
    setOpen(false);
    onRequestClose?.();
  }

  if (!checked || !open) return null;

  const paragraphs = DISCLAIMER_TEXT.split("\n\n").filter(Boolean);

  return (
    <div
      className="disclaimer-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="disclaimer-title"
    >
      <div className="disclaimer-modal">
        <div className="disclaimer-modal-header">
          <div className="disclaimer-modal-title-row">
            <span aria-hidden="true">⚠</span>
            <h2 id="disclaimer-title">Important Disclaimer</h2>
          </div>
          <p className="disclaimer-modal-meta">
            NuWrrrld Financial · version {DISCLAIMER_VERSION} · {DISCLAIMER_LAST_UPDATED}
          </p>
        </div>

        <div className="disclaimer-modal-body">
          {paragraphs.map((para, i) => {
            const dotIdx = para.indexOf(". ");
            const hasLeadLabel = dotIdx > 0 && dotIdx < 60;
            return (
              <p key={i}>
                {hasLeadLabel ? (
                  <>
                    <strong>{para.slice(0, dotIdx + 1)}</strong>
                    {para.slice(dotIdx + 1)}
                  </>
                ) : (
                  para
                )}
              </p>
            );
          })}
        </div>

        <div className="disclaimer-modal-footer">
          {forceOpen ? (
            <button onClick={dismiss} className="disclaimer-btn">Close</button>
          ) : (
            <>
              <button onClick={accept} className="disclaimer-btn">
                I understand — this is not investment advice
              </button>
              <p className="disclaimer-modal-note">
                You must acknowledge to use this page. This dialog re-appears if the disclaimer is updated.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
