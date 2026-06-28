import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { hasEntitlement, tierFromStatus } from "@/lib/subscription";
import type { SubscriptionStatus } from "@/lib/subscription";
import { HoldFoldClient } from "./HoldFoldClient";
import type { HoldFoldPayload } from "@/app/api/holdfold/route";
import "./holdfold.css";

export const metadata: Metadata = {
  title: "Hold/Fold · NuWrrrld Financial",
};

const MCP_URL = process.env.MCP_BACKEND_URL ?? "https://gcp3-backend-cif7ppahzq-uc.a.run.app";

async function fetchHoldFoldData(): Promise<HoldFoldPayload | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(`${MCP_URL}/signals`, {
      signal: controller.signal,
      next: { revalidate: 900 }, // 15 min server-side cache
    });
    if (!res.ok) return null;
    const raw = await res.json();
    if (!raw?.symbols || typeof raw.symbols !== "object" || Array.isArray(raw.symbols)) return null;

    const symbols = raw.symbols as Record<string, Record<string, unknown>>;
    const updatedAt = String(raw.updated ?? new Date().toISOString());

    function mapVerdict(action: string): "HOLD EM" | "FOLD EM" | "NEUTRAL" {
      if (action === "BUY") return "HOLD EM";
      if (action === "SELL") return "FOLD EM";
      return "NEUTRAL";
    }
    function mapBias(action: string): string {
      if (action === "BUY") return "bullish";
      if (action === "SELL") return "bearish";
      return "neutral";
    }
    function confToNum(label: string): number {
      if (label === "HIGH") return 80;
      if (label === "MEDIUM") return 55;
      return 30;
    }

    const verdicts = Object.entries(symbols).map(([key, s]) => {
      const ticker = String(s.symbol ?? key).trim().toUpperCase();
      const action = String(s.ai_action ?? "").toUpperCase();
      const confLabel = String(s.ai_confidence ?? "LOW").toUpperCase();
      const inds = (s.indicators ?? {}) as Record<string, number | null>;
      const rawSignals = Array.isArray(s.signals) ? s.signals as Record<string, unknown>[] : [];
      return {
        ticker,
        verdict: mapVerdict(action),
        confidence: confToNum(confLabel),
        confidenceLabel: confLabel,
        bias: mapBias(action),
        industry: String(s.industry ?? ""),
        rsi: inds.rsi ?? null,
        macd: inds.macd ?? null,
        adx: inds.adx ?? null,
        price: Number(s.price ?? 0),
        high52w: Number(s["52w_high"] ?? 0),
        low52w: Number(s["52w_low"] ?? 0),
        returns: (s.returns ?? {}) as Record<string, number>,
        signals: rawSignals.map(sig => ({
          signal: String(sig.signal ?? ""),
          strength: String(sig.strength ?? ""),
          detail: String(sig.detail ?? ""),
          category: String(sig.category ?? ""),
        })),
        aiSummary: String(s.ai_summary ?? ""),
        aiOutlook: String(s.ai_outlook ?? ""),
        updatedAt,
      };
    });

    verdicts.sort((a, b) => {
      const order = { "HOLD EM": 0, "FOLD EM": 1, "NEUTRAL": 2 };
      const od = order[a.verdict] - order[b.verdict];
      return od !== 0 ? od : b.confidence - a.confidence;
    });

    return {
      verdicts,
      total: verdicts.length,
      holdCount: verdicts.filter(v => v.verdict === "HOLD EM").length,
      foldCount: verdicts.filter(v => v.verdict === "FOLD EM").length,
      neutralCount: verdicts.filter(v => v.verdict === "NEUTRAL").length,
      updatedAt,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function formatUpdated(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-US", {
      month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit",
      timeZoneName: "short",
    });
  } catch {
    return iso;
  }
}

export default async function HoldFoldPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in?redirect_url=/dashboard/holdfold");

  const user = await currentUser();
  const status = (user?.publicMetadata?.subscription_status as SubscriptionStatus) ?? "free";
  const tier = tierFromStatus(status);

  if (!hasEntitlement("nu_ai", tier)) {
    redirect("/pricing?source=holdfold");
  }

  const data = await fetchHoldFoldData();

  return (
    <main className="hf-page">
      <div className="hf-header">
        <Link href="/dashboard" className="hf-back">← Dashboard</Link>
        <div className="hf-title-row">
          <div>
            <h1>Hold / Fold</h1>
            <p className="hf-subtitle">Tactical trade verdicts with bias, risk, and indicator context.</p>
          </div>
          {data && (
            <div className="hf-meta">
              <div className="hf-counts">
                <span className="hf-count hf-count--hold">{data.holdCount} HOLD EM</span>
                <span className="hf-count hf-count--fold">{data.foldCount} FOLD EM</span>
                <span className="hf-count hf-count--neutral">{data.neutralCount} NEUTRAL</span>
              </div>
              <p className="hf-updated">
                <span className="hf-updated-dot" />
                Updated {formatUpdated(data.updatedAt)}
              </p>
            </div>
          )}
        </div>
      </div>

      {!data ? (
        <div className="hf-empty">
          <p>Signals are refreshing — check back shortly.</p>
          <Link href="/dashboard" className="hf-cta">← Back to Dashboard</Link>
        </div>
      ) : (
        <HoldFoldClient data={data} />
      )}
    </main>
  );
}
