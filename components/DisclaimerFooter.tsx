"use client";
import { useState } from "react";
import { DISCLAIMER_VERSION, DISCLAIMER_LAST_UPDATED } from "@/lib/disclaimer";
import DisclaimerModal from "./DisclaimerModal";

interface Props {
  surface: "verdict" | "signals" | "portfolio" | "analyze";
}

/**
 * Persistent footer disclaimer. "View full disclaimer" opens the modal in
 * read-only viewer mode — it does NOT clear the stored acknowledgement.
 * (holdfold's version does `localStorage.removeItem` + reload here, which
 * destroys an audit-relevant record just to re-show text; portal's users
 * have accounts and a Neon-backed ack, so that pattern isn't safe to copy.)
 */
export default function DisclaimerFooter({ surface }: Props) {
  const [viewerOpen, setViewerOpen] = useState(false);

  return (
    <footer className="disclaimer-footer">
      <p>
        <span className="disclaimer-footer-lead">Not investment advice.</span>{" "}
        NuWrrrld Financial is an educational tool. Verdicts are AI-generated signals,
        not financial recommendations. Data may be cached or delayed. Options carry
        uncapped risk — losses may exceed premium paid. You are solely responsible
        for all trading decisions.{" "}
        <button onClick={() => setViewerOpen(true)} className="disclaimer-footer-link">
          View full disclaimer
        </button>
        {" "}· v{DISCLAIMER_VERSION} · {DISCLAIMER_LAST_UPDATED}
      </p>
      {viewerOpen && (
        <DisclaimerModal surface={surface} forceOpen onRequestClose={() => setViewerOpen(false)} />
      )}
    </footer>
  );
}
