"use client";

export default function CookiePreferencesLink() {
  function openPreferences() {
    window.dispatchEvent(new Event("nu:open-consent-preferences"));
  }

  return (
    <button className="consent-footer-link" onClick={openPreferences}>
      Cookie preferences
    </button>
  );
}
