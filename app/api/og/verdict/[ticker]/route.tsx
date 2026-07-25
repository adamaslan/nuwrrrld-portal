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

const DIRECTION_COLOR: Record<string, string> = {
  bullish: "#2fd8ff",
  bearish: "#ff3b5c",
  neutral: "#f4b83f",
};

export async function GET(_req: Request, { params }: { params: Promise<{ ticker: string }> }) {
  const { ticker: rawTicker } = await params;
  const ticker = normalizeTicker(rawTicker) ?? "TICKER";

  const [latest] = await recentVerdicts(ticker, 1);
  const direction = latest?.direction ?? null;
  const color = direction ? DIRECTION_COLOR[direction] ?? "#e8ecf4" : "#e8ecf4";

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
          background: "linear-gradient(135deg, #06070d 0%, #0d1018 100%)",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 10,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "linear-gradient(135deg, #2fd8ff, #f4b83f)",
              color: "#06100b",
              fontSize: 15,
              fontWeight: 900,
            }}
          >
            NWF
          </div>
          <div style={{ color: "#9aa4bd", fontSize: 22, fontWeight: 700 }}>NuWrrrld Financial</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ color: "#9aa4bd", fontSize: 26, fontWeight: 700 }}>6 AI analysts on</div>
          <div style={{ color: "#e8ecf4", fontSize: 84, fontWeight: 900, letterSpacing: -2 }}>{`$${ticker}`}</div>
          {direction ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", color, fontSize: 56, fontWeight: 900, textTransform: "uppercase" }}>
                {direction}
              </div>
              {latest?.invalidation && (
                <div style={{ display: "flex", color: "#9aa4bd", fontSize: 30, fontWeight: 700 }}>
                  {`Invalidation: ${latest.invalidation}`}
                </div>
              )}
            </div>
          ) : (
            <div style={{ color: "#9aa4bd", fontSize: 32, fontWeight: 700 }}>
              Ask the council — free, no account
            </div>
          )}
        </div>

        <div style={{ display: "flex", color: "#747267", fontSize: 20, fontWeight: 700 }}>
          One question. Six arguments. One answer.
        </div>
      </div>
    ),
    { width: 1200, height: 630 },
  );
}
