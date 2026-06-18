/**
 * Signal digest schema — single-sourced for app and web.
 * Version field guards against render-layer breakage when new signal types ship.
 */

export const DIGEST_SCHEMA_VERSION = 1;

export type SignalDirection = 'bullish' | 'bearish' | 'neutral';
export type SignalTimeframe = 'intraday' | 'short' | 'medium' | 'long';
export type SignalConfidence = 'low' | 'medium' | 'high';

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
}

export interface DigestPayload {
  schemaVersion: typeof DIGEST_SCHEMA_VERSION;
  periodLabel: string;       // e.g. "Week of Jun 16"
  signals: SignalPayload[];
  generatedAt: string;       // ISO
  /** Source optimizer IDs that produced this digest */
  sources: string[];
}

/** Adapter: normalise a raw optimizer response into a DigestPayload. */
export function normaliseDigest(raw: unknown, sources: string[]): DigestPayload {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid digest response');
  const r = raw as Record<string, unknown>;

  const rawSignals = Array.isArray(r.signals) ? r.signals : [];
  const signals: SignalPayload[] = rawSignals.map((s: unknown, i: number) => {
    const sig = (s ?? {}) as Record<string, unknown>;
    return {
      id: String(sig.id ?? `signal-${i}`),
      ticker: String(sig.ticker ?? ''),
      direction: (sig.direction as SignalDirection) ?? 'neutral',
      timeframe: (sig.timeframe as SignalTimeframe) ?? 'medium',
      confidence: (sig.confidence as SignalConfidence) ?? 'low',
      title: String(sig.title ?? sig.summary ?? ''),
      explanation: String(sig.explanation ?? sig.why ?? sig.reason ?? ''),
      indicators: Array.isArray(sig.indicators) ? sig.indicators.map(String) : [],
      generatedAt: String(sig.generated_at ?? sig.generatedAt ?? new Date().toISOString()),
    };
  });

  return {
    schemaVersion: DIGEST_SCHEMA_VERSION,
    periodLabel: String(r.period_label ?? r.periodLabel ?? ''),
    signals,
    generatedAt: String(r.generated_at ?? r.generatedAt ?? new Date().toISOString()),
    sources,
  };
}
