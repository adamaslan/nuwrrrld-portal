/**
 * Pure logic of the precompute layer (Option D,
 * docs/gha-modal-core-feature-coverage.md).
 *
 * `subjectFromTickers` is the piece worth pinning hardest: it is the cache key
 * for every precomputed artifact, so any instability in it silently re-spends
 * the free-tier quota the whole feature exists to conserve — a miss looks like
 * a cold cache, not like a bug.
 */
import { describe, expect, it } from "vitest";
import { subjectFromTickers } from "@/lib/shared/precompute-policy";

describe("subjectFromTickers — the precompute cache key", () => {
  it("is order-independent", () => {
    // Watchlist reads have no guaranteed order. If order leaked into the key,
    // the same portfolio would miss its own cached artifact and regenerate it.
    expect(subjectFromTickers(["MSFT", "AAPL"])).toBe(subjectFromTickers(["AAPL", "MSFT"]));
  });

  it("normalizes case", () => {
    expect(subjectFromTickers(["aapl"])).toBe(subjectFromTickers(["AAPL"]));
  });

  it("trims incidental whitespace", () => {
    expect(subjectFromTickers([" AAPL ", "MSFT"])).toBe("AAPL,MSFT");
  });

  it("de-duplicates repeated tickers", () => {
    expect(subjectFromTickers(["AAPL", "AAPL", "MSFT"])).toBe("AAPL,MSFT");
  });

  it("drops empty entries rather than emitting empty segments", () => {
    // A stray "" would otherwise produce ",AAPL" and split back into a phantom
    // ticker on the consuming side.
    expect(subjectFromTickers(["", "AAPL", "  "])).toBe("AAPL");
  });

  it("returns an empty string for an empty watchlist", () => {
    expect(subjectFromTickers([])).toBe("");
  });

  it("round-trips through split() back to the original ticker set", () => {
    // The precompute route reconstructs tickers with subject.split(","), so
    // the two operations must agree.
    const tickers = ["NVDA", "AAPL", "MSFT"];
    const subject = subjectFromTickers(tickers);
    expect(subject.split(",").filter(Boolean).sort()).toEqual([...tickers].sort());
  });

  it("distinguishes genuinely different portfolios", () => {
    expect(subjectFromTickers(["AAPL"])).not.toBe(subjectFromTickers(["AAPL", "MSFT"]));
  });
});
