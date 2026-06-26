/**
 * Shareable signal card — generates card data and share URLs.
 * Cards are branded images that share a signal with context and a deep link.
 */
import type { SignalPayload } from './digest';

export interface SignalCardData {
  signal: SignalPayload;
  imageUrl: string; // Generated card image
  shareUrl: string; // Deep link with card data
}

/**
 * Generate a shareable card from a signal.
 * imageUrl is built server-side to handle image generation;
 * shareUrl is a deep link back to this signal in-app.
 */
export function buildSignalCard(
  signal: SignalPayload,
  basePortalUrl: string,
  baseAppUrl: string,
): SignalCardData {
  // Server-side image generation endpoint — passes minimal signal data to avoid URL length limits.
  // POST to /api/signals/card to generate the actual image.
  const imageUrl = `${basePortalUrl}/api/signals/card?ticker=${encodeURIComponent(
    signal.ticker,
  )}&direction=${signal.direction}&confidence=${signal.confidence}&timeframe=${signal.timeframe}`;

  // Deep link back to this signal in the app (mobile) or web.
  // Uses signal ID so the native app can deep-link to the exact signal in the digest.
  const shareUrl = `${baseAppUrl}/signals/${signal.id}`;

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
