import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/signals/card/route";

function cardRequest(query: string): NextRequest {
  return new NextRequest(`https://financial.nuwrrrld.com/api/signals/card?${query}`);
}

describe("GET /api/signals/card", () => {
  it("renders an SVG for a normal ticker", async () => {
    const res = await GET(cardRequest("ticker=NVDA&direction=bullish"));
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toContain("<svg");
    expect(body).toContain("NVDA");
  });

  it("bounds an oversized ticker so the response cannot be amplified", async () => {
    // The route echoes `ticker` into the SVG through escapeXml, which expands
    // '&' to '&amp;' — 5 bytes out per byte in. Unbounded, a 200KB query string
    // produced a ~1MB response from this public, uncached endpoint.
    const hostile = "&".repeat(200_000);
    const res = await GET(cardRequest(`ticker=${encodeURIComponent(hostile)}`));
    const body = await res.text();

    expect(res.status).toBe(200);
    // Well under the ~1MB the unbounded version produced; the SVG chrome itself
    // is a few KB, so this asserts the ticker is no longer what drives the size.
    expect(body.length).toBeLessThan(10_000);
    expect(body).not.toContain("&amp;".repeat(50));
  });

  it("falls back to the neutral defaults when enum params are invalid", async () => {
    const res = await GET(cardRequest("ticker=AAPL&direction=sideways&confidence=extreme"));
    const body = await res.text();

    expect(res.status).toBe(200);
    // 'sideways' is not a valid direction, so the neutral colour is used.
    expect(body).toContain("#d97706");
  });

  it("escapes XML metacharacters so a ticker cannot inject markup", async () => {
    const res = await GET(cardRequest(`ticker=${encodeURIComponent("<script>")}`));
    const body = await res.text();

    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;");
  });
});
