import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect, notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { hasEntitlement, tierFromStatus } from "@/lib/subscription";
import type { SubscriptionStatus } from "@/lib/subscription";
import type { HoldFoldVerdict } from "@/app/api/holdfold/route";
import "../holdfold.css";

const MCP_URL = process.env.MCP_BACKEND_URL ?? "https://gcp3-backend-cif7ppahzq-uc.a.run.app";

// Distinct sentinel so the page can differentiate "backend down" from "ticker not found"
class BackendError extends Error {}

async function fetchVerdict(ticker: string): Promise<HoldFoldVerdict | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const res = await fetch(`${MCP_URL}/signals`, {
      signal: ctrl.signal,
      next: { revalidate: 900 },
    });
    if (!res.ok) throw new BackendError(`upstream ${res.status}`);
    const raw = await res.json() as Record<string, unknown>;
    if (!raw?.symbols || typeof raw.symbols !== "object" || Array.isArray(raw.symbols)) {
      throw new BackendError("invalid signals shape");
    }

    const symbols = raw.symbols as Record<string, Record<string, unknown>>;
    const upper = ticker.toUpperCase();
    const entry = Object.entries(symbols).find(([k, s]) =>
      String(s.symbol ?? k).trim().toUpperCase() === upper
    );
    if (!entry) return null; // ticker genuinely not in the dataset → caller sends notFound()
    const [key, s] = entry;

    const action = String(s.ai_action ?? "").toUpperCase();
    const confLabel = String(s.ai_confidence ?? "LOW").toUpperCase();
    const inds = (s.indicators ?? {}) as Record<string, number | null>;
    const rawSignals = Array.isArray(s.signals) ? s.signals as Record<string, unknown>[] : [];
    const updatedAt = String(raw.updated ?? new Date().toISOString());

    return {
      ticker: String(s.symbol ?? key).trim().toUpperCase(),
      verdict: action === "BUY" ? "HOLD EM" : action === "SELL" ? "FOLD EM" : "NEUTRAL",
      confidence: confLabel === "HIGH" ? 80 : confLabel === "MEDIUM" ? 55 : 30,
      confidenceLabel: confLabel,
      bias: action === "BUY" ? "bullish" : action === "SELL" ? "bearish" : "neutral",
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
  } catch (err) {
    if (err instanceof BackendError) throw err;
    if (ctrl.signal.aborted) throw new BackendError("upstream timeout");
    return null;
  } finally { clearTimeout(t); }
}

export async function generateMetadata(
  { params }: { params: Promise<{ ticker: string }> }
): Promise<Metadata> {
  const { ticker } = await params;
  return { title: `${ticker.toUpperCase()} · Hold/Fold · NuWrrrld Financial` };
}

function fmt(n: number | null) { return n == null ? "—" : n.toFixed(2); }

function StrengthBadge({ strength }: { strength: string }) {
  const s = strength.toUpperCase();
  const cls = s === "BULLISH" ? "hf-sig-badge hf-sig-badge--bull"
    : s === "BEARISH" ? "hf-sig-badge hf-sig-badge--bear"
    : "hf-sig-badge hf-sig-badge--neutral";
  return <span className={cls}>{strength}</span>;
}

export default async function TickerDetailPage(
  { params }: { params: Promise<{ ticker: string }> }
) {
  const { ticker } = await params;
  const { userId } = await auth();
  if (!userId) {
    const returnUrl = `/dashboard/holdfold/${encodeURIComponent(ticker)}`;
    redirect(`/sign-in?${new URLSearchParams({ redirect_url: returnUrl }).toString()}`);
  }

  const user = await currentUser();
  const status = (user?.publicMetadata?.subscription_status as SubscriptionStatus) ?? "free";
  const tier = tierFromStatus(status);

  if (!hasEntitlement("nu_ai", tier)) {
    redirect("/pricing?source=holdfold");
  }

  let v: HoldFoldVerdict | null;
  try {
    v = await fetchVerdict(ticker);
  } catch (err) {
    if (err instanceof BackendError) {
      // Backend unavailable — don't 404, surface a generic error
      throw err;
    }
    throw err;
  }
  if (!v) notFound();

  const verdictCls = v.verdict === "HOLD EM" ? "hf-verdict--hold" : v.verdict === "FOLD EM" ? "hf-verdict--fold" : "hf-verdict--neutral";

  return (
    <main className="hf-page">
      <div className="hf-header">
        <Link href="/dashboard/holdfold" className="hf-back">← Hold / Fold</Link>
      </div>

      <div className="hf-detail hf-detail--standalone">
        <div className="hf-detail-header">
          <div className="hf-detail-title">
            <span className="hf-detail-ticker">{v.ticker}</span>
            <span className={`hf-verdict-badge ${verdictCls}`}>{v.verdict}</span>
          </div>
          <p className="hf-detail-industry">{v.industry}</p>
        </div>

        <div className="hf-detail-conf">
          <span className="hf-conf-num">{v.confidence}</span>
          <span className="hf-conf-pct">%</span>
          <span className="hf-conf-label">confidence · {v.bias}</span>
        </div>

        <div className="hf-ind-grid">
          <div className="hf-ind-cell"><span className="hf-ind-label">RSI</span><span className="hf-ind-val">{fmt(v.rsi)}</span></div>
          <div className="hf-ind-cell"><span className="hf-ind-label">MACD</span><span className="hf-ind-val">{fmt(v.macd)}</span></div>
          <div className="hf-ind-cell"><span className="hf-ind-label">ADX</span><span className="hf-ind-val">{fmt(v.adx)}</span></div>
          <div className="hf-ind-cell"><span className="hf-ind-label">PRICE</span><span className="hf-ind-val">{v.price > 0 ? `$${v.price.toFixed(2)}` : "—"}</span></div>
          <div className="hf-ind-cell"><span className="hf-ind-label">52W HIGH</span><span className="hf-ind-val">{v.high52w > 0 ? `$${v.high52w.toFixed(2)}` : "—"}</span></div>
          <div className="hf-ind-cell"><span className="hf-ind-label">52W LOW</span><span className="hf-ind-val">{v.low52w > 0 ? `$${v.low52w.toFixed(2)}` : "—"}</span></div>
        </div>

        {Object.keys(v.returns).length > 0 && (
          <div className="hf-returns">
            <p className="hf-section-label">RETURNS</p>
            <div className="hf-ind-grid">
              {(["1d", "1w", "1m", "3m", "1y"] as const).filter(k => v.returns[k] != null).map(k => (
                <div key={k} className="hf-ind-cell">
                  <span className="hf-ind-label">{k.toUpperCase()}</span>
                  <span className={`hf-ind-val ${v.returns[k] >= 0 ? "hf-ret--up" : "hf-ret--down"}`}>
                    {v.returns[k] >= 0 ? "+" : ""}{v.returns[k].toFixed(2)}%
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {v.signals.length > 0 && (
          <div className="hf-sigs">
            <p className="hf-section-label">TOP SIGNALS</p>
            {v.signals.slice(0, 6).map((sig, i) => (
              <div key={i} className="hf-sig-row">
                <StrengthBadge strength={sig.strength} />
                <span className="hf-sig-text">{sig.signal}</span>
                {sig.detail && <span className="hf-sig-detail">{sig.detail}</span>}
              </div>
            ))}
          </div>
        )}

        {v.aiOutlook && (
          <div className="hf-outlook">
            <p className="hf-section-label">AI OUTLOOK</p>
            <p className="hf-outlook-text">{v.aiOutlook}</p>
          </div>
        )}

        <div className="hf-detail-footer">
          <Link href="/dashboard/holdfold" className="hf-back" style={{ margin: 0 }}>
            ← Back to all verdicts
          </Link>
          <p className="hf-updated" style={{ margin: 0 }}>
            <span className="hf-updated-dot" />
            {new Date(v.updatedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}
          </p>
        </div>
      </div>
    </main>
  );
}
