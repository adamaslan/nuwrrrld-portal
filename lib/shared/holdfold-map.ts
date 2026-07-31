/**
 * holdfold-map — pure mapping from gcp3's `/signals` payload to Hold/Fold
 * verdicts. Extracted from app/api/holdfold/route.ts so the daily brief can
 * reuse it: there is no `/holdfold` endpoint on the backend, so every consumer
 * has to derive verdicts from `/signals` the same way or they drift apart.
 *
 * Nothing here does I/O — the caller fetches, this shapes. That keeps it
 * unit-testable without a backend (same rationale as signal-policy.ts).
 */

export interface HoldFoldVerdict {
  ticker: string;
  verdict: "HOLD EM" | "FOLD EM" | "NEUTRAL";
  confidence: number;       // 0–100
  confidenceLabel: string;  // HIGH / MEDIUM / LOW
  bias: string;             // bullish / bearish / neutral
  industry: string;
  rsi: number | null;
  macd: number | null;
  adx: number | null;
  price: number;
  high52w: number;
  low52w: number;
  returns: Record<string, number>;
  signals: Array<{ signal: string; strength: string; detail: string; category: string }>;
  aiSummary: string;
  aiOutlook: string;
  updatedAt: string;
}

export interface HoldFoldPayload {
  verdicts: HoldFoldVerdict[];
  total: number;
  holdCount: number;
  foldCount: number;
  neutralCount: number;
  updatedAt: string;
}

function mapVerdict(action: string): HoldFoldVerdict["verdict"] {
  if (action === "BUY") return "HOLD EM";
  if (action === "SELL") return "FOLD EM";
  return "NEUTRAL";
}

function mapBias(action: string): string {
  if (action === "BUY") return "bullish";
  if (action === "SELL") return "bearish";
  return "neutral";
}

function confLabelToNum(label: string): number {
  if (label === "HIGH") return 80;
  if (label === "MEDIUM") return 55;
  return 30;
}

/** Sort order: HOLD EM first (confidence desc), then FOLD EM, then NEUTRAL. */
const VERDICT_ORDER: Record<HoldFoldVerdict["verdict"], number> = {
  "HOLD EM": 0,
  "FOLD EM": 1,
  "NEUTRAL": 2,
};

/**
 * Shape a raw `/signals` response into a sorted Hold/Fold payload.
 *
 * Returns null when the payload isn't the expected `{ symbols: {...} }` shape,
 * so callers can distinguish "backend gave us junk" from "backend gave us zero
 * verdicts" — the brief needs that distinction to avoid asking the model to
 * cite data that was never fetched.
 */
export function mapSignalsToHoldFold(raw: unknown): HoldFoldPayload | null {
  if (!raw || typeof raw !== "object") return null;

  const r = raw as Record<string, unknown>;
  if (!r.symbols || typeof r.symbols !== "object" || Array.isArray(r.symbols)) return null;

  const symbols = r.symbols as Record<string, Record<string, unknown>>;
  const updatedAt = String(r.updated ?? new Date().toISOString());

  const verdicts: HoldFoldVerdict[] = Object.entries(symbols).map(([key, s]) => {
    const ticker = String(s.symbol ?? key).trim().toUpperCase();
    const action = String(s.ai_action ?? "").toUpperCase();
    const confLabel = String(s.ai_confidence ?? "LOW").toUpperCase();
    const inds = (s.indicators ?? {}) as Record<string, number | null>;
    const rawSignals = Array.isArray(s.signals) ? (s.signals as Record<string, unknown>[]) : [];

    return {
      ticker,
      verdict: mapVerdict(action),
      confidence: confLabelToNum(confLabel),
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
    const od = VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict];
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
}
