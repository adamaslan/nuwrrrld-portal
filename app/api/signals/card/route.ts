import { NextRequest, NextResponse } from 'next/server';

// Monochrome law: no hue anywhere, including share cards. Direction reads as
// solid ink (bullish) vs ghost outline (bearish); neutral is gray.
const DIRECTION_FILL: Record<string, string> = {
  bullish: '#111111',
  bearish: '#ffffff',
  neutral: '#555555',
};

const DIRECTION_STROKE: Record<string, string> = {
  bullish: 'none',
  bearish: '#111111',
  neutral: 'none',
};

function directionShape(direction: string): string {
  const fill = DIRECTION_FILL[direction] || '#555555';
  const stroke = DIRECTION_STROKE[direction] || 'none';
  const strokeAttr = stroke === 'none' ? '' : ` stroke="${stroke}" stroke-width="4"`;
  if (direction === 'bullish') {
    return `<polygon points="80,218 140,218 110,162" fill="${fill}"${strokeAttr} />`;
  }
  if (direction === 'bearish') {
    return `<polygon points="80,162 140,162 110,218" fill="${fill}"${strokeAttr} />`;
  }
  return `<rect x="80" y="186" width="42" height="8" fill="${fill}" /><polygon points="122,172 150,190 122,208" fill="${fill}" />`;
}

const VALID_DIRECTIONS = new Set(['bullish', 'bearish', 'neutral']);
const VALID_CONFIDENCES = new Set(['low', 'medium', 'high']);
const VALID_TIMEFRAMES = new Set(['intraday', 'short', 'medium', 'long']);

// The other three params are enum-validated, so an oversized value is already
// discarded. `ticker` is free text and is echoed into the response, where
// escapeXml expands each character up to 5x ('&' -> '&amp;') — an unbounded
// input is therefore a response-amplification vector on a public, uncached
// endpoint. Real tickers fit well inside this.
const MAX_TICKER_LENGTH = 12;

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

  const ticker = escapeXml(rawTicker.slice(0, MAX_TICKER_LENGTH));
  const direction = VALID_DIRECTIONS.has(rawDirection) ? rawDirection : 'neutral';
  const confidence = VALID_CONFIDENCES.has(rawConfidence) ? rawConfidence : 'low';
  const timeframe = VALID_TIMEFRAMES.has(rawTimeframe) ? rawTimeframe : 'medium';

  const barFill = direction === 'bearish' ? '#ffffff' : (DIRECTION_FILL[direction] || '#555555');
  // Bearish bar is a ghost outline; inset the rect by half the stroke so the
  // outline is not clipped by the canvas edge.
  const barRect = direction === 'bearish'
    ? `<rect x="1" y="1" width="6" height="628" fill="${barFill}" stroke="#111111" stroke-width="2" />`
    : `<rect width="8" height="630" fill="${barFill}" />`;

  // Generate a branded card as SVG (shareable across all platforms)
  const svg = `
    <svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
      <!-- Background -->
      <rect width="1200" height="630" fill="#f5f5f5" />

      <!-- Left accent bar -->
      ${barRect}

      <!-- Card background: square, monochrome -->
      <rect x="40" y="40" width="1120" height="550" fill="#ffffff" rx="0" stroke="#111111" stroke-width="2" />

      <!-- Ticker + Direction (large) -->
      <text x="80" y="140" font-size="120" font-weight="700" fill="#111111" font-family="system-ui">
        ${ticker}
      </text>

      <!-- Direction mark: solid ink = bullish, ghost outline = bearish, gray bar/arrow = neutral -->
      ${directionShape(direction)}
      <text x="170" y="205" font-size="48" font-weight="600" fill="${direction === 'neutral' ? '#555555' : '#111111'}" font-family="system-ui">
        ${direction.toUpperCase()}
      </text>

      <!-- Meta: confidence + timeframe -->
      <text x="80" y="310" font-size="32" fill="#555555" font-family="system-ui">
        ${confidence} confidence · ${timeframe} timeframe
      </text>

      <!-- Footer: powered by NuWrrrld -->
      <text x="80" y="570" font-size="20" fill="#555555" font-family="system-ui">
        NuWrrrld Financial — Signal Share
      </text>

      <!-- Bottom right: disclaimer -->
      <text x="1080" y="570" font-size="14" fill="#555555" text-anchor="end" font-family="system-ui">
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
