import { describe, expect, it } from "vitest";
import { EVIDENCE_LEVELS } from "@/lib/shared/se1-catalog";
import {
  applyTriage, cacheEvict, cachePut, clearForUser, demotionRaisesUrgency, hapticTier, liveActivityPlan, OFFLINE_CACHE_MAX,
  shareUrl, tickerFromExtraction, validateSuggestions, voiceRunDecision, widgetState, type CachedDossier, type TriageAction,
} from "@/lib/shared/se1/mobile";

describe("H1: the widget shows last refresh and stale/unavailable state, and nothing private when locked", () => {
  const snap = { refreshed_at: "2026-11-08T12:00:00Z", flags: [{ ticker: "AAPL", scan_id: "se1.trend.golden_cross_recency" }] };
  const hour = 3_600_000;
  it("fresh, stale, unavailable", () => {
    expect(widgetState(snap, new Date("2026-11-08T12:30:00Z"), hour, false)).toMatchObject({ state: "fresh", refreshed_at: snap.refreshed_at });
    expect(widgetState(snap, new Date("2026-11-08T14:00:00Z"), hour, false)).toMatchObject({ state: "stale", refreshed_at: snap.refreshed_at });
    expect(widgetState(null, new Date(), hour, false).state).toBe("unavailable");
  });
  it("locked shows no tickers", () => {
    const r = widgetState(snap, new Date("2026-11-08T12:30:00Z"), hour, true);
    expect(r).toEqual({ state: "locked", refreshed_at: snap.refreshed_at });
    expect(JSON.stringify(r)).not.toContain("AAPL");
  });
});

describe("H2: ambiguous transcription needs confirmation before a costly run", () => {
  it("choose, confirm, run", () => {
    expect(voiceRunDecision(["AAPL", "APPL"], true)).toEqual({ run: false, reason: "choose", choices: ["AAPL", "APPL"] });
    expect(voiceRunDecision(["AAPL"], false)).toEqual({ run: false, reason: "confirm", choices: ["AAPL"] });
    expect(voiceRunDecision([" "], true).run).toBe(false);
    expect(voiceRunDecision(["AAPL", "AAPL"], true)).toEqual({ run: true, query: "AAPL" });
  });
});

describe("H3: offline triage replay is idempotent and converges across devices", () => {
  const a: TriageAction = { id: "a1", finding: "f1", action: "keep", at: "2026-11-08T10:00:00Z" };
  const b: TriageAction = { id: "b1", finding: "f1", action: "dismiss", at: "2026-11-08T10:05:00Z" };
  const c: TriageAction = { id: "c1", finding: "f2", action: "deep_dive", at: "2026-11-08T10:01:00Z" };
  it("same final state for any order and any number of replays", () => {
    const one = applyTriage({}, [a, b, c]);
    expect(applyTriage({}, [c, b, a])).toEqual(one);
    expect(applyTriage(one, [a, b, c])).toEqual(one);
    expect(one.f1.action).toBe("dismiss");
  });
});

describe("H4: logout clears private cached dossiers; the last-ten cap and age are enforced", () => {
  const now = new Date("2026-11-08T12:00:00Z");
  const entry = (i: number, user = "u1", ageMin = i): CachedDossier =>
    ({ user_id: user, ticker: `T${i}`, cached_at: new Date(now.getTime() - ageMin * 60_000).toISOString(), payload: {} });
  it("never more than ten, newest first; old entries are evicted", () => {
    let cache: CachedDossier[] = [];
    for (let i = 12; i >= 0; i--) cache = cachePut(cache, entry(i), now, 24 * 3_600_000);
    expect(cache).toHaveLength(OFFLINE_CACHE_MAX);
    expect(cache[0].ticker).toBe("T0");
    expect(cacheEvict([entry(1, "u1", 60 * 25)], now, 24 * 3_600_000)).toEqual([]);
  });
  it("clearing a user leaves nothing of theirs", () => {
    const cache = [entry(1, "u1"), entry(2, "u2"), entry(3, "u1")];
    expect(clearForUser(cache, "u1").map((c) => c.user_id)).toEqual(["u2"]);
  });
});

describe("H5: ambiguous extracted tickers need confirmation; no image data is returned", () => {
  it("one valid ticker passes; zero or many ask", () => {
    expect(tickerFromExtraction(["aapl", "AAPL"])).toEqual({ ticker: "AAPL" });
    expect(tickerFromExtraction(["AAPL", "MSFT"])).toEqual({ confirm: true, choices: ["AAPL", "MSFT"] });
    expect(tickerFromExtraction(["not a ticker!"])).toEqual({ confirm: true, choices: [] });
  });
});

describe("H6: unsupported devices get a fallback; cancelled events stop and redact", () => {
  it("cases", () => {
    expect(liveActivityPlan(false, { ticker: "AAPL", status: "scheduled" })).toEqual({ action: "fallback_notification", ticker: "AAPL" });
    const stop = liveActivityPlan(true, { ticker: "AAPL", status: "cancelled" }, { value: 125000 });
    expect(stop).toEqual({ action: "stop", payload: { ticker: "AAPL" } });
    expect(JSON.stringify(stop)).not.toContain("125000");
  });
});

describe("H7: no consent or quiet hours suppress haptics; demotion never raises urgency", () => {
  it("suppression", () => {
    expect(hapticTier("E4", false, false)).toBe("none");
    expect(hapticTier("E4", true, true)).toBe("none");
    expect(hapticTier("E4", true, false)).toBe("strong");
  });
  it("no demotion in the table raises the tier", () => {
    for (const from of EVIDENCE_LEVELS) for (const to of EVIDENCE_LEVELS) expect(demotionRaisesUrgency(from, to), `${from}→${to}`).toBe(false);
  });
});

describe("H8: sharing exports only an authorised public link, never a token", () => {
  const host = "financial.example";
  it("cases", () => {
    expect(shareUrl({ url: `https://${host}/d/abc`, public: true, revoked: false }, host)).toEqual({ url: `https://${host}/d/abc` });
    expect(shareUrl({ url: `https://${host}/d/abc?token=xyz`, public: true, revoked: false }, host)).toHaveProperty("error");
    expect(shareUrl({ url: `https://${host}/d/abc#s`, public: true, revoked: false }, host)).toHaveProperty("error");
    expect(shareUrl({ url: `https://evil.example/d/abc`, public: true, revoked: false }, host)).toHaveProperty("error");
    expect(shareUrl({ url: `https://${host}/d/abc`, public: true, revoked: true }, host)).toHaveProperty("error");
    expect(shareUrl({ url: `https://${host}/d/abc`, public: false, revoked: false }, host)).toHaveProperty("error");
  });
});

describe("H9: suggestions show rationale and uncertainty; no inferred holdings or certainty", () => {
  const ok = { ticker: "MSFT", rationale: "Large cloud exposure, which matches the stated interest.", uncertainty: "Valuation is high; this can fall." };
  it("cases", () => {
    expect(validateSuggestions([ok])).toEqual({ ok: true });
    expect(validateSuggestions(Array.from({ length: 6 }, () => ok)).ok).toBe(false);
    expect(validateSuggestions([{ ...ok, uncertainty: "" }]).ok).toBe(false);
    expect(validateSuggestions([{ ...ok, rationale: "This is guaranteed to rise." }]).ok).toBe(false);
    expect(validateSuggestions([{ ...ok, rationale: "Since you own NVDA already, add this." }]).ok).toBe(false);
  });
});
