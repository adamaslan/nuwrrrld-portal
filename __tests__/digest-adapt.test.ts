import { describe, expect, it } from "vitest";
import { adaptLiveSignals, DIGEST_SCHEMA_VERSION } from "@/lib/digest";

const FRESH = new Date().toISOString();

function payload(symbols: Record<string, Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  return { date: "2026-07-01", updated: FRESH, symbols, ...extra };
}

describe("adaptLiveSignals — response envelope", () => {
  it.each([
    ["null", null],
    ["a string", "nope"],
    ["a number", 42],
  ])("rejects %s as a response", (_label, raw) => {
    expect(() => adaptLiveSignals(raw)).toThrow("Invalid /signals response");
  });

  it.each([
    ["missing", {}],
    ["an array", { symbols: [] }],
    ["null", { symbols: null }],
  ])("rejects a symbols field that is %s", (_label, raw) => {
    expect(() => adaptLiveSignals(raw)).toThrow("symbols must be a plain object");
  });

  it("stamps the schema version, period label and source", () => {
    const d = adaptLiveSignals(payload({ AAPL: {} }));
    expect(d.schemaVersion).toBe(DIGEST_SCHEMA_VERSION);
    expect(d.periodLabel).toBe("Signals for 2026-07-01");
    expect(d.sources).toEqual(["gcp3-signals"]);
    expect(d.generatedAt).toBe(FRESH);
  });

  it("produces an empty signal list for an empty symbols map", () => {
    expect(adaptLiveSignals(payload({})).signals).toEqual([]);
  });
});

describe("adaptLiveSignals — ticker resolution", () => {
  it("falls back to the map key when the record omits `symbol`", () => {
    expect(adaptLiveSignals(payload({ MSFT: {} })).signals[0].ticker).toBe("MSFT");
  });

  it("prefers the map key over the record's own `symbol` (map key is authoritative)", () => {
    expect(adaptLiveSignals(payload({ TSLA: { symbol: "WRONG" } })).signals[0].ticker).toBe("TSLA");
  });

  it("falls back to the record's `symbol` only when the map key is blank", () => {
    expect(adaptLiveSignals(payload({ "  ": { symbol: "TSLA" } })).signals[0].ticker).toBe("TSLA");
  });

  it("trims and upper-cases the ticker", () => {
    expect(adaptLiveSignals(payload({ "  nvda  ": {} })).signals[0].ticker).toBe("NVDA");
  });

  it("uses the ticker as the id, falling back to a positional id when blank", () => {
    const signals = adaptLiveSignals(payload({ AAPL: {}, "  ": { symbol: "   " } })).signals;
    expect(signals[0].id).toBe("AAPL");
    expect(signals[1].id).toBe("signal-1");
  });
});

describe("adaptLiveSignals — direction and confidence mapping", () => {
  it.each([
    ["BUY", "bullish"],
    ["SELL", "bearish"],
    ["HOLD", "neutral"],
    ["", "neutral"],
  ] as const)("maps ai_action %s to %s", (action, direction) => {
    expect(adaptLiveSignals(payload({ X: { ai_action: action } })).signals[0].direction).toBe(direction);
  });

  it("maps ai_action case-insensitively", () => {
    expect(adaptLiveSignals(payload({ X: { ai_action: "buy" } })).signals[0].direction).toBe("bullish");
  });

  it("passes through a valid confidence and defaults an invalid one to low", () => {
    expect(adaptLiveSignals(payload({ X: { ai_confidence: "HIGH" } })).signals[0].confidence).toBe("high");
    expect(adaptLiveSignals(payload({ X: { ai_confidence: "wat" } })).signals[0].confidence).toBe("low");
  });

  it("always emits a medium timeframe (the live feed carries no timeframe)", () => {
    expect(adaptLiveSignals(payload({ X: {} })).signals[0].timeframe).toBe("medium");
  });
});

describe("adaptLiveSignals — nested signals array", () => {
  it("extracts indicator names and non-empty detail reasons", () => {
    const s = adaptLiveSignals(
      payload({
        X: {
          signals: [
            { signal: "RSI", detail: "oversold" },
            { signal: "MACD", detail: "" },
          ],
        },
      }),
    ).signals[0];
    expect(s.indicators).toEqual(["RSI", "MACD"]);
    expect(s.reasons).toEqual(["oversold"]);
  });

  it("omits reasons entirely when no detail text is present", () => {
    const s = adaptLiveSignals(payload({ X: { signals: [{ signal: "RSI" }] } })).signals[0];
    expect(s.reasons).toBeUndefined();
  });

  it("discards non-object entries in the signals array", () => {
    const s = adaptLiveSignals(
      payload({ X: { signals: [null, "junk", ["nested"], { signal: "ADX" }] } }),
    ).signals[0];
    expect(s.indicators).toEqual(["ADX"]);
  });

  it("tolerates a non-array signals field", () => {
    const s = adaptLiveSignals(payload({ X: { signals: "not-an-array" } })).signals[0];
    expect(s.indicators).toEqual([]);
  });
});

describe("adaptLiveSignals — counts and provenance", () => {
  it("emits signalCounts only when all three counts are numbers", () => {
    const complete = adaptLiveSignals(
      payload({ X: { bull_count: 3, bear_count: 1, signal_count: 4 } }),
    ).signals[0];
    expect(complete.signalCounts).toEqual({ bullish: 3, bearish: 1, total: 4 });

    const partial = adaptLiveSignals(payload({ X: { bull_count: 3, bear_count: 1 } })).signals[0];
    expect(partial.signalCounts).toBeUndefined();
  });

  it("keeps a numeric confluence score and drops a non-numeric one", () => {
    expect(adaptLiveSignals(payload({ X: { confluence_score: 0.91 } })).signals[0].score).toBe(0.91);
    expect(adaptLiveSignals(payload({ X: { confluence_score: "0.91" } })).signals[0].score).toBeUndefined();
  });

  it("keeps engine_version only when it is a string", () => {
    expect(adaptLiveSignals(payload({ X: { engine_version: "v2" } })).signals[0].engineVersion).toBe("v2");
    expect(adaptLiveSignals(payload({ X: { engine_version: 2 } })).signals[0].engineVersion).toBeUndefined();
  });
});

describe("adaptLiveSignals — staleness precedence", () => {
  it.each([
    ["fresh", false],
    ["stale", true],
    ["unknown", true],
  ] as const)("trusts the backend data_quality_score %s over the timestamp heuristic", (score, isStale) => {
    // Timestamp is fresh, so the heuristic alone would say "not stale" — the
    // backend's own verdict must win, because it reflects the true cache age.
    const s = adaptLiveSignals(payload({ X: { data_quality_score: score } })).signals[0];
    expect(s.dataQualityScore).toBe(score);
    expect(s.isStale).toBe(isStale);
  });

  it("falls back to the timestamp heuristic when the backend omits the field", () => {
    const fresh = adaptLiveSignals(payload({ X: {} })).signals[0];
    expect(fresh.dataQualityScore).toBeUndefined();
    expect(fresh.isStale).toBe(false);

    const old = new Date(Date.now() - 27 * 60 * 60 * 1000).toISOString();
    expect(adaptLiveSignals(payload({ X: {} }, { updated: old })).signals[0].isStale).toBe(true);
  });

  it("treats an unparsable timestamp as stale", () => {
    expect(
      adaptLiveSignals(payload({ X: {} }, { updated: "not-a-date" })).signals[0].isStale,
    ).toBe(true);
  });

  it("ignores an unrecognised data_quality_score and uses the heuristic instead", () => {
    const s = adaptLiveSignals(payload({ X: { data_quality_score: "bogus" } })).signals[0];
    expect(s.dataQualityScore).toBeUndefined();
    expect(s.isStale).toBe(false);
  });
});

describe("adaptLiveSignals — batch-wide generatedAt (the timing-correctness gap)", () => {
  // /signals returns ONE `updated` timestamp for the whole symbols map — see
  // adaptLiveSignals' `fallbackDate`. Every ticker's `generatedAt` (and, when
  // data_quality_score is absent, its isStale heuristic) is set from that one
  // shared value, never from a per-ticker timestamp. There is no field in the
  // /signals response that says "SOXX's confluence score was computed at
  // T_soxx" — only "this batch was updated at T_batch". If SOXX's own
  // scoring pipeline lagged (e.g. a stale price fetch upstream of gcp3) while
  // the rest of the batch refreshed on time, `updated` still looks fresh and
  // isStale stays false for every ticker, SOXX included. This is exactly the
  // failure class behind a signal card showing "1d +4.17%" that doesn't match
  // reality: the number can be old even though nothing about the batch
  // envelope says so.
  it("gives every ticker in a batch the identical generatedAt, regardless of per-ticker data age", () => {
    const d = adaptLiveSignals(payload({ SOXX: {}, AAPL: {}, TSLA: {} }));
    const stamps = new Set(d.signals.map((s) => s.generatedAt));
    expect(stamps.size).toBe(1);
    expect([...stamps][0]).toBe(FRESH);
  });

  it("EXPOSE: a ticker with its own stale data_quality_score is the only reliable per-ticker staleness signal", () => {
    // The batch envelope is fresh (FRESH), but gcp3 flags this one ticker's
    // own analysis as stale via data_quality_score — that field is the ONLY
    // per-ticker timing signal this adapter can act on. If gcp3 ever omits
    // data_quality_score for a genuinely stale individual ticker, this
    // adapter has no way to detect it: computeIsStale() falls back to the
    // batch-wide `updated`, which by construction looks fine.
    const d = adaptLiveSignals(
      payload({ SOXX: { data_quality_score: "stale" }, AAPL: {} }),
    );
    const soxx = d.signals.find((s) => s.ticker === "SOXX")!;
    const aapl = d.signals.find((s) => s.ticker === "AAPL")!;
    expect(soxx.isStale).toBe(true);
    expect(aapl.isStale).toBe(false);
    // Both still carry the SAME generatedAt — staleness diverged, the
    // timestamp that's supposed to explain "as of when" did not.
    expect(soxx.generatedAt).toBe(aapl.generatedAt);
  });
});
