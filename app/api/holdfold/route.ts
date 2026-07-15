import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { getLatestHoldFoldCache, saveHoldFoldCache } from "@/lib/holdfold-cache-db";

const MCP_URL = process.env.MCP_BACKEND_URL ?? "https://gcp3-backend-cif7ppahzq-uc.a.run.app";
const TIMEOUT_MS = 8_000;

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

async function fetchSignals(): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${MCP_URL}/signals`, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// In-process L1 cache (15 min) in front of the durable Neon cache — survives
// within one serverless instance's lifetime; Neon survives cold starts.
const L1_TTL_MS = 15 * 60 * 1000;
let l1Cache: { payload: HoldFoldPayload; expiresAt: number } | null = null;

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  if (l1Cache && l1Cache.expiresAt > Date.now()) {
    return NextResponse.json(l1Cache.payload);
  }

  const dbCached = await getLatestHoldFoldCache();
  if (dbCached) {
    l1Cache = { payload: dbCached, expiresAt: Date.now() + L1_TTL_MS };
    return NextResponse.json(dbCached);
  }

  const raw = await fetchSignals();
  if (!raw || typeof raw !== "object") {
    return NextResponse.json({ error: "signals unavailable" }, { status: 503 });
  }

  const r = raw as Record<string, unknown>;
  if (!r.symbols || typeof r.symbols !== "object" || Array.isArray(r.symbols)) {
    return NextResponse.json({ error: "invalid signals shape" }, { status: 502 });
  }

  const symbols = r.symbols as Record<string, Record<string, unknown>>;
  const updatedAt = String(r.updated ?? new Date().toISOString());

  const verdicts: HoldFoldVerdict[] = Object.entries(symbols).map(([key, s]) => {
    const ticker = String(s.symbol ?? key).trim().toUpperCase();
    const action = String(s.ai_action ?? "").toUpperCase();
    const confLabel = String(s.ai_confidence ?? "LOW").toUpperCase();
    const inds = (s.indicators ?? {}) as Record<string, number | null>;
    const rawSignals = Array.isArray(s.signals) ? s.signals as Record<string, unknown>[] : [];

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

  // Sort: HOLD EM first by confidence desc, then FOLD EM, then NEUTRAL
  verdicts.sort((a, b) => {
    const order = { "HOLD EM": 0, "FOLD EM": 1, "NEUTRAL": 2 };
    const od = order[a.verdict] - order[b.verdict];
    if (od !== 0) return od;
    return b.confidence - a.confidence;
  });

  const holdCount = verdicts.filter(v => v.verdict === "HOLD EM").length;
  const foldCount = verdicts.filter(v => v.verdict === "FOLD EM").length;
  const neutralCount = verdicts.filter(v => v.verdict === "NEUTRAL").length;

  const payload: HoldFoldPayload = {
    verdicts,
    total: verdicts.length,
    holdCount,
    foldCount,
    neutralCount,
    updatedAt,
  };

  l1Cache = { payload, expiresAt: Date.now() + L1_TTL_MS };
  await saveHoldFoldCache(payload);
  return NextResponse.json(payload);
}
