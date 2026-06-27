/**
 * Shareable signal card — generates card data and share URLs.
 * Cards are branded images that share a signal with context and a deep link.
 */
import type { SignalPayload } from './digest';

export interface SignalCardData {
  signal: SignalPayload;
  imageUrl: string; // Generated card image
  shareUrl: string; // Deep link to signal on web (clickable in share sheets)
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
  // Normalize once — used for both imageUrl and shareUrl to avoid double-slash paths.
  const normalizedBase = basePortalUrl.endsWith('/') ? basePortalUrl.slice(0, -1) : basePortalUrl;

  // Server-side image generation — encode all params to prevent malformed URLs.
  const imageUrl = `${normalizedBase}/api/signals/card?${new URLSearchParams({
    ticker: signal.ticker,
    direction: signal.direction,
    confidence: signal.confidence,
    timeframe: signal.timeframe,
  }).toString()}`;

  // Deep link to signal — web-clickable URL with id anchor so the share scrolls to the right card.
  // Universal Links (iOS) + App Links (Android) on the domain route to native app if installed.
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
