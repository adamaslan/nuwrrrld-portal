"use client";
import { useState } from "react";

export function CheckoutButton({ plan, label }: { plan: "monthly" | "annual"; label: string }) {
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    setLoading(true);
    try {
      const res = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      if (res.status === 401) {
        // Auth is only required at the actual checkout action — send the
        // user to sign in and bring them right back to pricing afterward.
        window.location.href = "/sign-in?redirect_url=/pricing";
        return;
      }
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        alert("Could not start checkout. Please try again.");
      }
    } catch {
      alert("Could not start checkout. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={handleClick}
      disabled={loading}
      className="checkout-btn"
    >
      {loading ? "Loading…" : label}
    </button>
  );
}
