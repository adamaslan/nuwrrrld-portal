import { NextRequest, NextResponse } from 'next/server';

const DIRECTION_COLOR: Record<string, string> = {
  bullish: '#16a34a',
  bearish: '#dc2626',
  neutral: '#d97706',
};

const DIRECTION_EMOJI: Record<string, string> = {
  bullish: '📈',
  bearish: '📉',
  neutral: '➡️',
};

const VALID_DIRECTIONS = new Set(['bullish', 'bearish', 'neutral']);
const VALID_CONFIDENCES = new Set(['low', 'medium', 'high']);
const VALID_TIMEFRAMES = new Set(['intraday', 'short', 'medium', 'long']);

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}


export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const rawTicker = searchParams.get('ticker') || 'UNKNOWN';
  const rawDirection = searchParams.get('direction') || 'neutral';
  const rawConfidence = searchParams.get('confidence') || 'low';
  const rawTimeframe = searchParams.get('timeframe') || 'medium';

  const ticker = escapeXml(rawTicker);
  const direction = VALID_DIRECTIONS.has(rawDirection) ? rawDirection : 'neutral';
  const confidence = VALID_CONFIDENCES.has(rawConfidence) ? rawConfidence : 'low';
  const timeframe = VALID_TIMEFRAMES.has(rawTimeframe) ? rawTimeframe : 'medium';

  const color = DIRECTION_COLOR[direction] || '#666';
  const emoji = DIRECTION_EMOJI[direction] || '➡️';

  // Generate a branded card as SVG (shareable across all platforms)
  const svg = `
    <svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style="stop-color:#f9fafb;stop-opacity:1" />
          <stop offset="100%" style="stop-color:#f3f4f6;stop-opacity:1" />
        </linearGradient>
      </defs>

      <!-- Background -->
      <rect width="1200" height="630" fill="url(#bgGrad)" />

      <!-- Left accent bar -->
      <rect width="8" height="630" fill="${color}" />

      <!-- Card background -->
      <rect x="40" y="40" width="1120" height="550" fill="white" rx="16" stroke="${color}" stroke-width="2" />

      <!-- Ticker + Direction (large) -->
      <text x="80" y="140" font-size="120" font-weight="700" fill="#111" font-family="system-ui">
        ${ticker}
      </text>

      <!-- Direction emoji + label -->
      <text x="80" y="220" font-size="48" fill="${color}" font-family="system-ui">
        ${emoji} ${direction.toUpperCase()}
      </text>

      <!-- Meta: confidence + timeframe -->
      <text x="80" y="310" font-size="32" fill="#6b7280" font-family="system-ui">
        ${confidence} confidence · ${timeframe} timeframe
      </text>

      <!-- Footer: powered by NuWrrrld -->
      <text x="80" y="570" font-size="20" fill="#9ca3af" font-family="system-ui">
        NuWrrrld Financial — Signal Share
      </text>

      <!-- Bottom right: disclaimer -->
      <text x="1080" y="570" font-size="14" fill="#9ca3af" text-anchor="end" font-family="system-ui">
        Not financial advice
      </text>
    </svg>
  `.trim();

  return new NextResponse(svg, {
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
    },
  });
}
