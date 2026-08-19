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
import {
  THESIS_BATCH_SIZE,
  batchThesisSubjects,
  resolvePrecomputeSource,
  subjectFromTickers,
} from "@/lib/shared/precompute-policy";

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

describe("resolvePrecomputeSource", () => {
  it("opts into ranking only on the exact value", () => {
    expect(resolvePrecomputeSource("ranking")).toBe("ranking");
  });

  // A scheduled job spends the day's quota. A typo in its body must not
  // silently redirect that spend at a different pool of tickers, so anything
  // unrecognized stays on the pre-existing watchlist behavior.
  it.each([["watchlist"], ["Ranking"], ["rank"], [""], [null], [undefined], [1]])(
    "falls back to watchlist for %o",
    (input) => {
      expect(resolvePrecomputeSource(input)).toBe("watchlist");
    },
  );
});

describe("batchThesisSubjects — the quota arithmetic", () => {
  const tickers = (n: number) => Array.from({ length: n }, (_, i) => `T${i}`);

  it("packs a full batch into one subject", () => {
    const out = batchThesisSubjects(tickers(THESIS_BATCH_SIZE));
    expect(out).toHaveLength(1);
    expect(out[0].split(",")).toHaveLength(THESIS_BATCH_SIZE);
  });

  // The whole point: 100 tickers cost 10 requests against a 50/day ceiling,
  // not 100. If this ever returns one subject per ticker the feature stops
  // fitting in the free tier at all.
  it("turns 100 tickers into 10 requests, not 100", () => {
    expect(batchThesisSubjects(tickers(100))).toHaveLength(10);
  });

  it("keeps a trailing partial batch", () => {
    const out = batchThesisSubjects(tickers(THESIS_BATCH_SIZE + 1));
    expect(out).toHaveLength(2);
    expect(out[1].split(",")).toHaveLength(1);
  });

  it("returns nothing for an empty ranking", () => {
    expect(batchThesisSubjects([])).toEqual([]);
  });

  // Batch membership follows the ranking so an early stop keeps the best
  // tickers; the subject *key* is still sorted, by subjectFromTickers.
  it("keeps the highest-ranked tickers in the first batch", () => {
    const ranked = ["ZZZ", "AAA", "MMM", "BBB"];
    const [first] = batchThesisSubjects(ranked, 2);
    expect(first).toBe(subjectFromTickers(["ZZZ", "AAA"]));
    expect(first).toBe("AAA,ZZZ");
  });

  it("de-duplicates across the whole ranking, not just within a batch", () => {
    const out = batchThesisSubjects(["AAPL", "MSFT", "aapl", "NVDA"], 2);
    expect(out).toEqual(["AAPL,MSFT", "NVDA"]);
  });

  it("drops blanks rather than emitting an empty subject", () => {
    expect(batchThesisSubjects(["AAPL", "", "  ", "MSFT"], 10)).toEqual(["AAPL,MSFT"]);
  });

  it("treats a nonsense batch size as one per batch", () => {
    expect(batchThesisSubjects(["A", "B"], 0)).toEqual(["A", "B"]);
    expect(batchThesisSubjects(["A", "B"], -5)).toEqual(["A", "B"]);
  });
});
