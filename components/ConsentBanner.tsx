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

        // If GPC/DNT is active and user hasn't made a choice, auto-opt-out
        if (gpc && needsPrompt(data.record)) {
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
    try {
      await fetch("/api/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          choices: { preferences: true, analytics: true, marketing: true },
          source: "banner_accept_all",
        }),
      });
    } catch {
      // Fail gracefully
    }
    setShowBanner(false);
  }

  async function rejectAll() {
    try {
      await fetch("/api/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          choices: {},
          source: "banner_reject_all",
        }),
      });
    } catch {
      // Fail gracefully
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
