"use client";
import { useEffect, useState } from "react";
import "./share.css";

const SITE_URL = "https://financial.nuwrrrld.com";

export function SharePanel() {
  const [code, setCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [referralsCompleted, setReferralsCompleted] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/referral")
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(d => { setCode(d.code); setReferralsCompleted(d.referralsCompleted ?? 0); })
      .catch(() => setError("Could not load your referral code."));
  }, []);

  const referralUrl = code ? `${SITE_URL}/pricing?ref=${code}` : null;

  async function copyLink() {
    if (!referralUrl) return;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(referralUrl);
      } else {
        // Fallback for non-secure contexts
        const el = document.createElement("textarea");
        el.value = referralUrl;
        document.body.appendChild(el);
        el.select();
        document.execCommand("copy");
        document.body.removeChild(el);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Silent — user can manually copy the URL shown below
    }
  }

  const tweetText = encodeURIComponent(
    `I've been using @NuWrrrldFin for AI stock signals with plain-language explanations. 7-day free trial: ${referralUrl}`
  );

  if (error) return <p className="share-error">{error}</p>;
  if (!code) return <p className="share-loading">Loading your referral code…</p>;

  return (
    <div className="share-panel">
      <div className="share-code-block">
        <span className="share-code">{code}</span>
        <button className="share-copy-btn" onClick={copyLink}>
          {copied ? "Copied!" : "Copy link"}
        </button>
      </div>

      <p className="share-url">{referralUrl}</p>

      <div className="share-channels">
        <a
          href={`https://twitter.com/intent/tweet?text=${tweetText}`}
          target="_blank" rel="noreferrer"
          className="share-channel-btn share-channel-btn--twitter"
        >
          Share on X
        </a>
        <a
          href={`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(referralUrl ?? '')}`}
          target="_blank" rel="noreferrer"
          className="share-channel-btn share-channel-btn--linkedin"
        >
          Share on LinkedIn
        </a>
      </div>

      <div className="share-stats">
        <strong>{referralsCompleted}</strong>
        <span>{referralsCompleted === 1 ? "friend" : "friends"} subscribed via your link</span>
      </div>

      <p className="share-terms">
        Both you and your referral get one free month when they subscribe.
        Free months are applied after their first paid month.
        Not financial advice.
      </p>
    </div>
  );
}
