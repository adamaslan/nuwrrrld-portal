'use client';

import { useState } from 'react';

interface SignalAskAnythingProps {
  /** Ticker to ask about, e.g. "AAPL" */
  ticker: string;
}

type Status = 'idle' | 'loading' | 'ok' | 'error';

/**
 * Free-form "ask anything about this signal" chat — calls the tool-using
 * agent behind /api/signals/{ticker}/chat, which must look up the ticker's
 * real live signal (score, action, data quality) via gcp3's explain_signal
 * tool before answering, rather than guessing from an LLM's own training data.
 *
 * Distinct from the existing "Go Deeper — T1 Council" button (a single fixed
 * prompt): this lets the user ask their own question.
 */
export function SignalAskAnything({ ticker }: SignalAskAnythingProps) {
  const [question, setQuestion] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleAsk() {
    const q = question.trim();
    if (!q || status === 'loading') return;
    setStatus('loading');
    setError(null);
    try {
      const res = await fetch(`/api/signals/${encodeURIComponent(ticker)}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data?.error === 'string' ? data.error : `Error ${res.status}`);
        setStatus('error');
        return;
      }
      setAnswer(typeof data?.answer === 'string' ? data.answer : null);
      setStatus('ok');
    } catch {
      setError('Could not reach the signal chat agent.');
      setStatus('error');
    }
  }

  return (
    <div className="signal-ask-anything">
      <div className="signal-ask-anything-input-row">
        <input
          type="text"
          className="signal-ask-anything-input"
          placeholder={`Ask anything about ${ticker}'s signal…`}
          value={question}
          onChange={e => setQuestion(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleAsk(); }}
        />
        <button
          className="signal-deeper-btn"
          onClick={handleAsk}
          disabled={status === 'loading' || !question.trim()}
        >
          {status === 'loading' ? 'Asking…' : 'Ask'}
        </button>
      </div>
      {status === 'ok' && answer && (
        <p className="signal-ask-anything-answer">{answer}</p>
      )}
      {status === 'error' && error && (
        <p className="signal-deeper-error">{error}</p>
      )}
    </div>
  );
}
