"use client";

import { useEffect, useState } from "react";
import { needsPrompt, CONSENT_VERSION, type ConsentRecord } from "@/lib/shared/consent";
import ConsentPreferences from "./ConsentPreferences";
import "./consent.css";

export default function ConsentBanner() {
  const [ready, setReady] = useState(false);
  const [showBanner, setShowBanner] = useState(false);
  const [showPrefs, setShowPrefs] = useState(false);
  const [gpcActive, setGpcActive] = useState(false);
  // `fetch` resolves for non-2xx, so a rejected write used to dismiss the banner
  // anyway — the user believed they had chosen while no cookie or audit row was
  // written. Keep the banner up and say so instead.
  const [saveError, setSaveError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        // Check for GPC or DNT signal
        const nav =
          typeof navigator !== "undefined"
            ? (navigator as Navigator & { globalPrivacyControl?: boolean })
            : undefined;
        const gpc =
          nav?.globalPrivacyControl === true ||
          nav?.doNotTrack === "1" ||
          nav?.doNotTrack === "yes";

        if (gpc) {
          setGpcActive(true);
        }

        const res = await fetch("/api/consent");
        const data = (await res.json()) as { record: ConsentRecord | null };

        if (cancelled) return;

        // GPC/DNT is a legally binding opt-out under CPRA and applies
        // "regardless of any prior choice" (see applyDoNotTrack in
        // lib/shared/consent.ts). Gating this on needsPrompt() contradicted
        // that: a visitor who accepted analytics and *later* enabled GPC kept
        // being tracked, because their existing record made needsPrompt false.
        // Post the opt-out whenever the signal is active and the stored record
        // doesn't already reflect it.
        const alreadyOptedOut =
          data.record?.choices?.analytics === false &&
          data.record?.choices?.marketing === false;
        if (gpc && !alreadyOptedOut) {
          try {
            await fetch("/api/consent", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                choices: {
                  preferences: data.record?.choices?.preferences ?? false,
                },
                source: "gpc",
              }),
            });
          } catch {
            // Fail gracefully
          }
          // Show banner as note-only (no accept/reject buttons)
          if (!cancelled) {
            setShowBanner(true);
          }
        } else if (needsPrompt(data.record)) {
          // Show normal banner with all options
          if (!cancelled) {
            setShowBanner(true);
          }
        } else {
          // User has already made a choice
          if (!cancelled) {
            setShowBanner(false);
          }
        }
      } catch {
        // Fail gracefully
        if (!cancelled) {
          setShowBanner(false);
        }
      }

      if (!cancelled) {
        setReady(true);
      }
    }

    check();

    // Listen for custom event to open preferences (from CookiePreferencesLink)
    const handleOpenPrefs = () => {
      setShowPrefs(true);
    };

    window.addEventListener("nu:open-consent-preferences", handleOpenPrefs);

    return () => {
      cancelled = true;
      window.removeEventListener("nu:open-consent-preferences", handleOpenPrefs);
    };
  }, []);

  async function acceptAll() {
    setSaveError(false);
    try {
      const res = await fetch("/api/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          choices: { preferences: true, analytics: true, marketing: true },
          source: "banner_accept_all",
        }),
      });
      if (!res.ok) throw new Error(`consent write failed: ${res.status}`);
    } catch {
      setSaveError(true);
      return;
    }
    setShowBanner(false);
  }

  async function rejectAll() {
    setSaveError(false);
    try {
      const res = await fetch("/api/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          choices: {},
          source: "banner_reject_all",
        }),
      });
      if (!res.ok) throw new Error(`consent write failed: ${res.status}`);
    } catch {
      setSaveError(true);
      return;
    }
    setShowBanner(false);
  }

  function openManage() {
    setShowPrefs(true);
  }

  async function recheckAfterClose() {
    try {
      const res = await fetch("/api/consent");
      const data = (await res.json()) as { record: ConsentRecord | null };
      // Re-evaluate whether the banner should still show
      if (needsPrompt(data.record)) {
        setShowBanner(true);
      } else {
        setShowBanner(false);
      }
    } catch {
      // Fail gracefully
    }
  }

  if (!ready) return null;

  return (
    <>
      {showBanner && (
        <div className="consent-banner">
          <div className="consent-banner-inner">
            {gpcActive ? (
              <>
                <div className="consent-banner-text">
                  <strong>Privacy control honored.</strong> We detected a browser privacy setting
                  (GPC or DNT) and have automatically disabled analytics and marketing tracking.
                </div>
                <div className="consent-banner-actions">
                  <button className="consent-footer-link" onClick={openManage}>
                    Manage preferences
                  </button>
                  <button
                    className="consent-btn-secondary"
                    onClick={() => setShowBanner(false)}
                    style={{ marginLeft: "auto" }}
                  >
                    Dismiss
                  </button>
                </div>
                <p className="consent-note">Consent policy v{CONSENT_VERSION}</p>
              </>
            ) : (
              <>
                <div className="consent-banner-text">
                  <strong>We use cookies and tracking</strong> to improve your experience, measure
                  product usage, and deliver targeted content. You control which categories to
                  allow.
                </div>
                {saveError && (
                  <div className="consent-banner-text" role="alert">
                    <strong>We couldn&apos;t save that choice.</strong> Nothing has been changed —
                    please try again.
                  </div>
                )}
                <div className="consent-banner-actions">
                  <button className="consent-btn" onClick={acceptAll}>
                    Accept all
                  </button>
                  <button className="consent-btn-secondary" onClick={rejectAll}>
                    Reject all
                  </button>
                  <button className="consent-btn-secondary" onClick={openManage}>
                    Manage
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <ConsentPreferences
        open={showPrefs}
        onClose={async () => {
          setShowPrefs(false);
          await recheckAfterClose();
        }}
      />
    </>
  );
}
