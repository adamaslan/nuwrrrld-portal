'use client';

import { useState } from 'react';
import type { BacktestResult } from '@/lib/backtest';

interface TrackRecordBadgeProps {
  /** Ticker to backtest, e.g. "AAPL" */
  symbol: string;
  /** Signal confidence/strength label to match against `by_strength` buckets, when available */
  strength?: string;
}

type Status = 'idle' | 'loading' | 'ok' | 'empty' | 'error';

/**
 * Lazily-loaded track-record badge — fetches historical hit-rate data for a
 * symbol from the (separate) backtest engine on demand, via /api/backtest/{symbol}.
 * Renders nothing until the user opts in, so it never adds a request per
 * signal card on page load.
 */
export function TrackRecordBadge({ symbol, strength }: TrackRecordBadgeProps) {
  const [status, setStatus] = useState<Status>('idle');
  const [result, setResult] = useState<BacktestResult | null>(null);

  async function handleLoad() {
    if (status === 'loading') return;
    setStatus('loading');
    try {
      const res = await fetch(`/api/backtest/${encodeURIComponent(symbol)}`);
      if (res.status === 204) {
        setStatus('empty');
        return;
      }
      if (!res.ok) {
        setStatus('error');
        return;
      }
      const data = (await res.json()) as BacktestResult;
      setResult(data);
      setStatus('ok');
    } catch {
      setStatus('error');
    }
  }

  if (status === 'idle') {
    return (
      <button className="signal-deeper-btn" onClick={handleLoad}>
        Show track record
      </button>
    );
  }

  if (status === 'loading') {
    return <p className="signal-score">Loading historical hit-rate…</p>;
  }

  if (status === 'empty') {
    return <p className="signal-score">Historical hit-rate data unavailable for {symbol}.</p>;
  }

  if (status === 'error') {
    return <p className="signal-score">Couldn't load track record for {symbol}.</p>;
  }

  if (!result) return null;

  // Prefer a bucket matching the signal's strength/confidence label; fall back to
  // the strongest category bucket by sample size so the badge always has a number.
  const strengthBucket = strength
    ? result.by_strength.find(b => b.key.toLowerCase() === strength.toLowerCase())
    : undefined;
  const bucket =
    strengthBucket ??
    [...result.by_category].sort((a, b) => b.total - a.total)[0];

  if (!bucket || bucket.total === 0) {
    return <p className="signal-score">No historical samples yet for {symbol}.</p>;
  }

  return (
    <p className="signal-score">
      Historical hit-rate ({bucket.key}): {Math.round(bucket.hit_rate * 100)}% (n={bucket.total})
    </p>
  );
}
