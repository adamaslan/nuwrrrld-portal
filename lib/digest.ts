/**
 * Signal digest schema — single-sourced for app and web.
 * Version field guards against render-layer breakage when new signal types ship.
 */

export const DIGEST_SCHEMA_VERSION = 1;

export type SignalDirection = 'bullish' | 'bearish' | 'neutral';
export type SignalTimeframe = 'intraday' | 'short' | 'medium' | 'long';
export type SignalConfidence = 'low' | 'medium' | 'high';

const VALID_DIRECTIONS = new Set<string>(['bullish', 'bearish', 'neutral']);
const VALID_TIMEFRAMES = new Set<string>(['intraday', 'short', 'medium', 'long']);
const VALID_CONFIDENCES = new Set<string>(['low', 'medium', 'high']);

function safeDirection(v: unknown): SignalDirection {
  return VALID_DIRECTIONS.has(String(v)) ? (v as SignalDirection) : 'neutral';
}
function safeTimeframe(v: unknown): SignalTimeframe {
  return VALID_TIMEFRAMES.has(String(v)) ? (v as SignalTimeframe) : 'medium';
}
function safeConfidence(v: unknown): SignalConfidence {
  return VALID_CONFIDENCES.has(String(v)) ? (v as SignalConfidence) : 'low';
}

/** Signals older than this are flagged stale — daily-refresh data plus a margin for weekends/delays. */
const STALE_THRESHOLD_MS = 26 * 60 * 60 * 1000;

/** Data-quality guard: true when a signal's timestamp is missing/unparsable or older than the threshold. */
function computeIsStale(generatedAt: string): boolean {
  const ms = Date.parse(generatedAt);
  if (Number.isNaN(ms)) return true;
  return Date.now() - ms > STALE_THRESHOLD_MS;
}

export interface SignalPayload {
  id: string;
  ticker: string;
  direction: SignalDirection;
  timeframe: SignalTimeframe;
  confidence: SignalConfidence;
  /** Short headline — shown above the fold */
  title: string;
  /** Plain-language "why this signal" explanation for trust */
  explanation: string;
  /** Which indicators contributed (e.g. ["RSI", "MACD", "Volume"]) */
  indicators: string[];
  generatedAt: string; // ISO
  /** Weighted confluence score in [-1, 1], when the source computes one */
  score?: number;
  /** Per-indicator explanations backing the signal (one sentence each) */
  reasons?: string[];
  /** How many contributing signals were bullish/bearish/total, when available */
  signalCounts?: { bullish: number; bearish: number; total: number };
  /** True when generatedAt is missing or older than the freshness threshold — display boundary must gate on this */
  isStale: boolean;
  /** Which scoring engine/version produced this signal, when the source reports one (provenance) */
  engineVersion?: string;
}

export interface DigestPayload {
  schemaVersion: typeof DIGEST_SCHEMA_VERSION;
  periodLabel: string;       // e.g. "Week of Jun 16"
  signals: SignalPayload[];
  generatedAt: string;       // ISO
  /** Source optimizer IDs that produced this digest */
  sources: string[];
}

/**
 * Adapter: GCP3 Finance API v2 /signals response (symbols map) → DigestPayload.
 * The live backend returns { date, updated, total, symbols: { TICKER: {...} } }
 * rather than a signals array. This bridges the two shapes.
 */
export function adaptLiveSignals(raw: unknown): DigestPayload {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid /signals response');
  const r = raw as Record<string, unknown>;
  // Validate symbols is a plain object — reject arrays or nulls at the boundary.
  if (!r.symbols || typeof r.symbols !== 'object' || Array.isArray(r.symbols)) {
    throw new Error('Invalid /signals response: symbols must be a plain object');
  }
  const symbols = r.symbols as Record<string, Record<string, unknown>>;
  const fallbackDate = String(r.updated ?? new Date().toISOString());

  // Use Object.entries so the map key (authoritative ticker) is always available
  // even when the inner record omits the redundant `symbol` field.
  const signals: SignalPayload[] = Object.entries(symbols).map(([symbolKey, s], i) => {
    const ticker = String(s.symbol ?? symbolKey).trim().toUpperCase();
    const action = String(s.ai_action ?? '').toUpperCase();
    const direction: SignalDirection =
      action === 'BUY' ? 'bullish' : action === 'SELL' ? 'bearish' : 'neutral';
    const rawConf = String(s.ai_confidence ?? '').toLowerCase();
    const rawSignals = Array.isArray(s.signals)
      ? (s.signals as unknown[]).filter(
          (x): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x),
        )
      : [];
    const indicators: string[] = rawSignals.map(x => String(x.signal ?? ''));
    const reasons: string[] = rawSignals.map(x => String(x.detail ?? '')).filter(Boolean);
    const score = typeof s.confluence_score === 'number' ? s.confluence_score : undefined;
    const bullish = typeof s.bull_count === 'number' ? s.bull_count : undefined;
    const bearish = typeof s.bear_count === 'number' ? s.bear_count : undefined;
    const total = typeof s.signal_count === 'number' ? s.signal_count : undefined;
    const engineVersion = typeof s.engine_version === 'string' ? s.engine_version : undefined;
    return {
      id: ticker || `signal-${i}`,
      ticker,
      direction,
      timeframe: 'medium',
      confidence: safeConfidence(rawConf),
      title: String(s.ai_summary ?? ''),
      explanation: String(s.ai_outlook ?? ''),
      indicators,
      generatedAt: fallbackDate,
      score,
      reasons: reasons.length > 0 ? reasons : undefined,
      signalCounts:
        bullish !== undefined && bearish !== undefined && total !== undefined
          ? { bullish, bearish, total }
          : undefined,
      isStale: computeIsStale(fallbackDate),
      engineVersion,
    };
  });

  return {
    schemaVersion: DIGEST_SCHEMA_VERSION,
    periodLabel: `Signals for ${String(r.date ?? '')}`,
    signals,
    generatedAt: fallbackDate,
    sources: ['gcp3-signals'],
  };
}

/** Adapter: normalise a raw optimizer response into a DigestPayload. */
export function normaliseDigest(raw: unknown, sources: string[]): DigestPayload {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid digest response');
  const r = raw as Record<string, unknown>;

  // Single fallback timestamp for the whole batch — avoids per-signal Date construction.
  const fallbackDate = new Date().toISOString();

  const rawSignals = Array.isArray(r.signals) ? r.signals : [];
  const signals: SignalPayload[] = rawSignals.map((s: unknown, i: number) => {
    const sig = (s ?? {}) as Record<string, unknown>;
    const generatedAt = String(sig.generated_at ?? sig.generatedAt ?? fallbackDate);
    return {
      id: String(sig.id ?? `signal-${i}`),
      ticker: String(sig.ticker ?? ''),
      direction: safeDirection(sig.direction),
      timeframe: safeTimeframe(sig.timeframe),
      confidence: safeConfidence(sig.confidence),
      title: String(sig.title ?? sig.summary ?? ''),
      explanation: String(sig.explanation ?? sig.why ?? sig.reason ?? ''),
      indicators: Array.isArray(sig.indicators) ? sig.indicators.map(String) : [],
      generatedAt,
      isStale: computeIsStale(generatedAt),
      score: typeof sig.score === 'number' ? sig.score : undefined,
      reasons: Array.isArray(sig.reasons) ? sig.reasons.map(String) : undefined,
      signalCounts:
        sig.signalCounts && typeof sig.signalCounts === 'object'
          ? (sig.signalCounts as SignalPayload['signalCounts'])
          : undefined,
      engineVersion: typeof sig.engineVersion === 'string' ? sig.engineVersion : undefined,
    };
  });

  return {
    schemaVersion: DIGEST_SCHEMA_VERSION,
    periodLabel: String(r.period_label ?? r.periodLabel ?? ''),
    signals,
    generatedAt: String(r.generated_at ?? r.generatedAt ?? fallbackDate),
    sources,
  };
}
