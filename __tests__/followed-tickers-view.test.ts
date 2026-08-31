/**
 * followed-tickers-view — unit tests for the dashboard view-model builder.
 * Pure: no DB, no React. Both the portal page and a future mobile screen
 * render this shape, so its number logic is pinned here.
 */
import { describe, expect, it } from "vitest";
import {
  buildFollowedTickersView,
  HORIZON_LABEL,
  type RawObservation,
  type RawPick,
  type RawScore,
} from "@/lib/shared/followed-tickers-view";

const pick = (over: Partial<RawPick> = {}): RawPick => ({
  id: "p1",
  cohortMonth: "2026-09-01",
  ticker: "NVDA",
  direction: "bull",
  entryPrice: 100,
  confidence: null,
  droppedAt: null,
  ...over,
});

const obs = (over: Partial<RawObservation> = {}): RawObservation => ({
  pickId: "p1",
  observedOn: "2026-09-02",
  closePrice: 105,
  signalDir: "bullish",
  backtestRate: 0.71,
  councilJson: { outlook: "bullish" },
  ...over,
});

describe("buildFollowedTickersView — empty", () => {
  it("flags empty when there are no picks", () => {
    const v = buildFollowedTickersView({ picks: [], observationsByPick: {}, scores: [] });
    expect(v.empty).toBe(true);
    expect(v.bulls).toHaveLength(0);
    expect(v.scoreboard).toHaveLength(7); // still one row per horizon
    expect(v.scoreboard.every((r) => r.n === 0 && r.notYetAvailable)).toBe(true);
    expect(v.judge).toBeNull();
  });
});

describe("cohort cards", () => {
  it("computes directional return for a bull (price up = positive)", () => {
    const v = buildFollowedTickersView({
      picks: [pick()],
      observationsByPick: { p1: [obs({ closePrice: 110 })] },
      scores: [],
    });
    expect(v.empty).toBe(false);
    expect(v.bulls[0].directionalReturnPct).toBeCloseTo(10);
    expect(v.bulls[0].lastPrice).toBe(110);
  });

  it("computes directional return for a bear (price down = positive)", () => {
    const v = buildFollowedTickersView({
      picks: [pick({ direction: "bear" })],
      observationsByPick: { p1: [obs({ closePrice: 90, signalDir: "bearish" })] },
      scores: [],
    });
    expect(v.bears[0].directionalReturnPct).toBeCloseTo(10);
  });

  it("null return when there is no observation yet", () => {
    const v = buildFollowedTickersView({ picks: [pick()], observationsByPick: {}, scores: [] });
    expect(v.bulls[0].directionalReturnPct).toBeNull();
    expect(v.bulls[0].lastPrice).toBeNull();
    expect(v.bulls[0].daysHeld).toBeNull();
    expect(v.bulls[0].thesisHolding).toBe(true); // unknown ⇒ assume holding
  });

  it("marks thesis broken when the latest signal disagrees with the pick", () => {
    const v = buildFollowedTickersView({
      picks: [pick()],
      observationsByPick: {
        p1: [
          obs({ observedOn: "2026-09-02", signalDir: "bullish" }),
          obs({ observedOn: "2026-09-03", signalDir: "bearish" }),
        ],
      },
      scores: [],
    });
    expect(v.bulls[0].thesisHolding).toBe(false);
    expect(v.bulls[0].daysHeld).toBe(1); // held day 1, flipped day 2
  });

  it("carries backtest %, council outlook, and judge score onto the card", () => {
    const v = buildFollowedTickersView({
      picks: [pick()],
      observationsByPick: { p1: [obs()] },
      scores: [{ pickId: "p1", horizon: "w1", outcome: "hit", directional: 5, returnPct: 5, judgeScore: 8 }],
    });
    const c = v.bulls[0];
    expect(c.backtestRatePct).toBeCloseTo(71);
    expect(c.councilOutlook).toBe("bullish");
    expect(c.judgeScore).toBe(8);
  });

  it("splits bulls and bears", () => {
    const v = buildFollowedTickersView({
      picks: [pick({ id: "a", ticker: "AAA", direction: "bull" }), pick({ id: "b", ticker: "BBB", direction: "bear" })],
      observationsByPick: {},
      scores: [],
    });
    expect(v.bulls.map((c) => c.ticker)).toEqual(["AAA"]);
    expect(v.bears.map((c) => c.ticker)).toEqual(["BBB"]);
  });
});

describe("scoreboard", () => {
  const many = (n: number, outcome: RawScore["outcome"]): RawScore[] =>
    Array.from({ length: n }, (_, i) => ({
      pickId: `p${i}`,
      horizon: "w1" as const,
      outcome,
      directional: outcome === "hit" ? 4 : -4,
      returnPct: outcome === "hit" ? 4 : -4,
      judgeScore: null,
    }));

  it("suppresses the rate below n=30 but keeps counts + notYetAvailable=false", () => {
    const v = buildFollowedTickersView({
      picks: [pick()],
      observationsByPick: {},
      scores: [...many(10, "hit"), ...many(5, "miss")],
    });
    const w1 = v.scoreboard.find((r) => r.horizon === "w1")!;
    expect(w1.n).toBe(15);
    expect(w1.hits).toBe(10);
    expect(w1.misses).toBe(5);
    expect(w1.hitRatePct).toBeNull();
    expect(w1.notYetAvailable).toBe(false);
  });

  it("publishes the rate once n reaches 30", () => {
    const v = buildFollowedTickersView({
      picks: [pick()],
      observationsByPick: {},
      scores: [...many(21, "hit"), ...many(9, "miss")],
    });
    const w1 = v.scoreboard.find((r) => r.horizon === "w1")!;
    expect(w1.hitRatePct).toBeCloseTo(70);
  });

  it("a horizon with no scores reads notYetAvailable", () => {
    const v = buildFollowedTickersView({ picks: [pick()], observationsByPick: {}, scores: [] });
    expect(v.scoreboard.find((r) => r.horizon === "y1")!.notYetAvailable).toBe(true);
  });
});

describe("judge + quadrant", () => {
  it("null judge when nothing graded", () => {
    const v = buildFollowedTickersView({
      picks: [pick()],
      observationsByPick: {},
      scores: [{ pickId: "p1", horizon: "w1", outcome: "hit", directional: 5, returnPct: 5, judgeScore: null }],
    });
    expect(v.judge).toBeNull();
  });

  it("mean judge score over graded verdicts", () => {
    const v = buildFollowedTickersView({
      picks: [pick()],
      observationsByPick: {},
      scores: [
        { pickId: "p1", horizon: "w1", outcome: "hit", directional: 5, returnPct: 5, judgeScore: 8 },
        { pickId: "p2", horizon: "w1", outcome: "miss", directional: -5, returnPct: -5, judgeScore: 6 },
      ],
    });
    expect(v.judge!.verdictsGraded).toBe(2);
    expect(v.judge!.meanScore).toBeCloseTo(7);
  });

  it("bins the outcome × judge quadrant, watching the hit·low cell", () => {
    const v = buildFollowedTickersView({
      picks: [pick()],
      observationsByPick: {},
      scores: [
        { pickId: "a", horizon: "w1", outcome: "hit", directional: 5, returnPct: 5, judgeScore: 9 },
        { pickId: "b", horizon: "w1", outcome: "hit", directional: 5, returnPct: 5, judgeScore: 3 },
        { pickId: "c", horizon: "w1", outcome: "miss", directional: -5, returnPct: -5, judgeScore: 8 },
        { pickId: "d", horizon: "w1", outcome: "miss", directional: -5, returnPct: -5, judgeScore: 2 },
        { pickId: "e", horizon: "w1", outcome: "flat", directional: 0, returnPct: 0, judgeScore: 5 },
      ],
    });
    expect(v.quadrant).toEqual({
      hitHighJudge: 1,
      missHighJudge: 1,
      hitLowJudge: 1, // the dangerous cell
      missLowJudge: 1,
    });
  });
});

describe("HORIZON_LABEL", () => {
  it("has a human label for every horizon key", () => {
    for (const k of ["d1", "w1", "m1", "m3", "m6", "ytd", "y1"] as const) {
      expect(HORIZON_LABEL[k]).toBeTruthy();
    }
  });
});
