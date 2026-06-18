"use client";
import { useState } from "react";

export function ManageBillingButton() {
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    setLoading(true);
    try {
      const res = await fetch("/api/stripe/portal", { method: "POST" });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        alert("Could not open billing portal. Please try again.");
      }
    } catch {
      alert("Could not open billing portal. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <button onClick={handleClick} disabled={loading} className="manage-billing-btn">
      {loading ? "Loading…" : "Manage subscription"}
    </button>
  );
}
