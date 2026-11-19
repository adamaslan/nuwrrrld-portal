/**
 * GET /api/og/verdict/[ticker]
 * Shareable OG image: "6 AI analysts on $TICKER: BULLISH, invalidation < 462."
 * Sources the latest row from council_verdicts; falls back to a generic
 * "ask the council" card when no verdict exists yet for this ticker — never
 * a broken image (concept-cache-then-degrade).
 */
import { ImageResponse } from "next/og";
import { normalizeTicker } from "@/lib/shared/signal-policy";
import { recentVerdicts } from "@/lib/council-db";

// Monochrome OG card (style guide): direction is stated in the verdict text
// itself; the accent only distinguishes emphasis, never meaning by color.
const DIRECTION_COLOR: Record<string, string> = {
  bullish: "#111111",
  bearish: "#111111",
  neutral: "#555555",
};

export async function GET(_req: Request, { params }: { params: Promise<{ ticker: string }> }) {
  const { ticker: rawTicker } = await params;
  const ticker = normalizeTicker(rawTicker) ?? "TICKER";

  const [latest] = await recentVerdicts(ticker, 1);
  const direction = latest?.direction ?? null;
  const color = direction ? DIRECTION_COLOR[direction] ?? "#111111" : "#111111";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "64px",
          background: "#ffffff",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "#111111",
              color: "#ffffff",
              fontSize: 15,
              fontWeight: 900,
            }}
          >
            NWF
          </div>
          <div style={{ color: "#555555", fontSize: 22, fontWeight: 700 }}>NuWrrrld Financial</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ color: "#555555", fontSize: 26, fontWeight: 700 }}>6 AI analysts on</div>
          <div style={{ color: "#111111", fontSize: 84, fontWeight: 900, letterSpacing: -2 }}>{`$${ticker}`}</div>
          {direction ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", color, fontSize: 56, fontWeight: 900, textTransform: "uppercase" }}>
                {direction}
              </div>
              {latest?.invalidation && (
                <div style={{ display: "flex", color: "#555555", fontSize: 30, fontWeight: 700 }}>
                  {`Invalidation: ${latest.invalidation}`}
                </div>
              )}
            </div>
          ) : (
            <div style={{ color: "#555555", fontSize: 32, fontWeight: 700 }}>
              Ask the council — free, no account
            </div>
          )}
        </div>

        <div style={{ display: "flex", color: "#555555", fontSize: 20, fontWeight: 700 }}>
          One question. Six arguments. One answer.
        </div>
      </div>
    ),
    { width: 1200, height: 630 },
  );
}
