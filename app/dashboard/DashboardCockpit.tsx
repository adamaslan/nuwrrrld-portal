"use client";
import { useState } from "react";
import Link from "next/link";
import { consumeSSE } from "@/lib/shared/sse";

export interface MoverChip {
  ticker: string;
  verdict: string;
  confidenceLabel: string;
  href: string;
}

interface Props {
  isPro: boolean;
  movers?: MoverChip[];
}

function MoversStrip({ movers }: { movers: MoverChip[] }) {
  if (movers.length === 0) return null;
  return (
    <div className="cockpit-movers">
      <span className="cockpit-movers-label">Top movers →</span>
      {movers.map(m => {
        const isHold = m.verdict === "HOLD EM";
        const isFold = m.verdict === "FOLD EM";
        return (
          <Link
            key={m.ticker}
            href={m.href}
            className={`cockpit-mover-chip cockpit-mover-chip--${isHold ? "hold" : isFold ? "fold" : "neutral"}`}
          >
            <span className="cockpit-mover-ticker">{m.ticker}</span>
            <span className="cockpit-mover-verdict">{m.verdict}</span>
            <span className="cockpit-mover-conf">{m.confidenceLabel}</span>
          </Link>
        );
      })}
    </div>
  );
}

export function DashboardCockpit({ isPro, movers = [] }: Props) {
  const [briefStatus, setBriefStatus] = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [brief, setBrief] = useState("");
  const [briefError, setBriefError] = useState("");

  async function generateBrief() {
    if (briefStatus === "loading") return;
    setBriefStatus("loading");
    setBrief("");
    setBriefError("");
    try {
      const res = await fetch("/api/brief", { method: "POST" });
      if (res.status === 403) {
        setBriefStatus("error");
        setBriefError("Pro feature — upgrade to generate your daily brief.");
        return;
      }
      if (!res.ok) {
        setBriefStatus("error");
        setBriefError("Brief unavailable — try again shortly.");
        return;
      }
      const contentType = res.headers.get("content-type") ?? "";
      let finalText = "";
      if (contentType.includes("text/event-stream")) {
        await consumeSSE(res, (_delta, accumulated) => { finalText = accumulated; setBrief(accumulated); });
      } else {
        const data = await res.json();
        finalText = data.brief ?? data.answer ?? "";
        setBrief(finalText);
      }
      if (!finalText) {
        setBriefStatus("error");
        setBriefError("Brief returned empty — try again.");
      } else {
        setBriefStatus("ok");
      }
    } catch (err) {
      setBriefStatus("error");
      setBriefError(err instanceof Error ? err.message : "Failed to generate brief.");
    }
  }

  return (
    <div className="cockpit">
      <MoversStrip movers={movers} />

      <div className="cockpit-brief">
        {briefStatus === "idle" && (
          <button
            className={`cockpit-brief-btn${!isPro ? " cockpit-brief-btn--locked" : ""}`}
            onClick={generateBrief}
          >
            {isPro ? "✦ Generate my morning brief" : "✦ Morning brief (Pro)"}
          </button>
        )}
        {briefStatus === "loading" && (
          <div className="cockpit-brief-card cockpit-brief-card--loading">
            <p className="cockpit-brief-label">Daily Brief</p>
            <p className="cockpit-brief-text">{brief || "Nu AI is composing your brief…"}</p>
          </div>
        )}
        {briefStatus === "ok" && brief && (
          <div className="cockpit-brief-card">
            <p className="cockpit-brief-label">Daily Brief · Nu AI</p>
            <p className="cockpit-brief-text">{brief}</p>
            <button className="cockpit-brief-regen" onClick={generateBrief}>↺ Regenerate</button>
          </div>
        )}
        {briefStatus === "error" && (
          <div className="cockpit-brief-error">
            <p>{briefError}</p>
            <button className="cockpit-brief-regen" onClick={() => setBriefStatus("idle")}>Try again</button>
          </div>
        )}
      </div>
    </div>
  );
}
