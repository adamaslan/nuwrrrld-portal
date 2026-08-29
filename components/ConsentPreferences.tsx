"use client";

import { useEffect, useState } from "react";
import {
  CONSENT_CATEGORIES,
  CATEGORY_INFO,
  type ConsentChoices,
  type ConsentRecord,
} from "@/lib/shared/consent";
import "./consent.css";

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function ConsentPreferences({ open, onClose }: Props) {
  const [choices, setChoices] = useState<ConsentChoices>({
    strictly_necessary: true,
    preferences: false,
    analytics: false,
    marketing: false,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;

    async function fetch_record() {
      try {
        const res = await fetch("/api/consent");
        const data = (await res.json()) as { record: ConsentRecord | null };
        if (!cancelled) {
          setChoices(
            data.record?.choices ?? {
              strictly_necessary: true,
              preferences: false,
              analytics: false,
              marketing: false,
            }
          );
          setLoading(false);
        }
      } catch {
        // Fail safe: defaults remain
        if (!cancelled) setLoading(false);
      }
    }

    fetch_record();
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function savePreferences() {
    try {
      await fetch("/api/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choices, source: "preferences" }),
      });
    } catch {
      // Fail gracefully
    }
    onClose();
  }

  async function rejectAll() {
    try {
      await fetch("/api/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choices: {}, source: "preferences" }),
      });
    } catch {
      // Fail gracefully
    }
    onClose();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      onClose();
    }
  }

  if (!open) return null;

  return (
    <div
      className="consent-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="consent-prefs-title"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="consent-modal">
        <div className="consent-modal-header">
          <h2 id="consent-prefs-title">Cookie & Tracking Preferences</h2>
          <p>Manage which types of cookies and tracking we use.</p>
        </div>

        <div className="consent-modal-body">
          {CONSENT_CATEGORIES.map((category) => {
            const info = CATEGORY_INFO[category];
            const isRequired = info.required;
            const isChecked = choices[category];

            return (
              <div key={category} className="consent-category-row">
                <div style={{ flex: 1 }}>
                  <label className="consent-category-label">
                    {info.label}
                    {isRequired && (
                      <span style={{ color: "var(--text-dim)", marginLeft: "4px" }}>
                        (required)
                      </span>
                    )}
                  </label>
                  <p className="consent-category-desc">{info.description}</p>
                </div>
                <input
                  type="checkbox"
                  className="consent-toggle"
                  checked={isChecked}
                  disabled={isRequired}
                  onChange={(e) => {
                    setChoices({
                      ...choices,
                      [category]: e.target.checked,
                    });
                  }}
                  aria-label={`Toggle ${info.label}`}
                />
              </div>
            );
          })}
        </div>

        <div className="consent-modal-footer">
          <button className="consent-btn" onClick={savePreferences} disabled={loading}>
            Save preferences
          </button>
          <button className="consent-btn-secondary" onClick={rejectAll} disabled={loading}>
            Reject all
          </button>
        </div>
      </div>
    </div>
  );
}
