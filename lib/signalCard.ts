/**
 * Shareable signal card — generates card data and share URLs.
 * Cards are branded images that share a signal with context and a deep link.
 */
import type { SignalPayload } from './digest';

export interface SignalCardData {
  signal: SignalPayload;
  imageUrl: string; // Generated card image
  shareUrl: string; // Web link to signal (clickable everywhere)
}

/**
 * Generate a shareable card from a signal.
 * imageUrl is generated server-side; shareUrl is a web link (clickable in share sheets).
 * Use basePortalUrl for both to ensure shareUrl is web-clickable across all platforms.
 */
export function buildSignalCard(
  signal: SignalPayload,
  basePortalUrl: string,
  baseAppUrl: string,
): SignalCardData {
  // Server-side image generation — encode all params to prevent malformed URLs
  const imageUrl = `${basePortalUrl}/api/signals/card?${new URLSearchParams({
    ticker: signal.ticker,
    direction: signal.direction,
    confidence: signal.confidence,
    timeframe: signal.timeframe,
  }).toString()}`;

  // Deep link to signal — use portal URL so it's clickable in share sheets.
  // Universal Links (iOS) + App Links (Android) on the domain will route to native app if installed.
  const normalizedBase = basePortalUrl.endsWith('/') ? basePortalUrl.slice(0, -1) : basePortalUrl;
  const shareUrl = `${normalizedBase}/dashboard/signals#signal-${signal.id}`;

  return {
    signal,
    imageUrl,
    shareUrl,
  };
}

/**
 * Format a signal for sharing on social.
 * Title + ticker + direction + confidence in a single line.
 */
export function formatSignalForShare(signal: SignalPayload): string {
  const arrow = signal.direction === 'bullish' ? '📈' : signal.direction === 'bearish' ? '📉' : '➡️';
  return `${arrow} ${signal.ticker} ${signal.direction.toUpperCase()} (${signal.confidence} confidence)`;
}
