/**
 * docs/council-paper-portfolios.md §2.1 is final input, transcribed verbatim
 * into scripts/seed-paper-portfolios.mjs — these tests pin the arithmetic the
 * design doc itself got wrong once (526 vs the correct 501), and the
 * no-overlap / no-derivation invariants the doc calls load-bearing.
 */
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs script, no type declarations
import {
  ACCOUNTS,
  ACCOUNT_IDS,
  CORE_50,
  EXTRAS,
  PAPER_POLICY_VERSION,
  SPY_HOLDING,
  STARTING_CASH,
} from "@/scripts/seed-paper-portfolios.mjs";

describe("CORE_50", () => {
  it("has exactly 50 distinct tickers", () => {
    expect(CORE_50).toHaveLength(50);
    expect(new Set(CORE_50).size).toBe(50);
  });
});

describe("EXTRAS", () => {
  const seats = ["t1", "t2", "risk", "macro", "quant", "chair"];

  it("has exactly 25 distinct tickers per seat, none overlapping the Core 50", () => {
    const core = new Set(CORE_50);
    for (const seat of seats) {
      const list = EXTRAS[seat];
      expect(list).toHaveLength(25);
      expect(new Set(list).size).toBe(25);
      expect(list.some((t: string) => core.has(t))).toBe(false);
    }
  });
});

describe("SPY_HOLDING", () => {
  it("is IVV, not SPY (§2.1 — SPY is not a registered ticker_universe symbol)", () => {
    expect(SPY_HOLDING).toBe("IVV");
  });
});

describe("ACCOUNTS / ACCOUNT_IDS", () => {
  it("has all 8 accounts in the design doc's §2 table order", () => {
    expect(ACCOUNT_IDS).toEqual(["t1", "t2", "risk", "macro", "quant", "chair", "equal", "spy"]);
  });

  it("each of the 6 trading accounts has a 75-name watchlist (Core 50 + 25 extras)", () => {
    for (const seat of ["t1", "t2", "risk", "macro", "quant", "chair"]) {
      expect(ACCOUNTS[seat].tickers).toHaveLength(75);
      expect(new Set(ACCOUNTS[seat].tickers).size).toBe(75);
      expect(ACCOUNTS[seat].seat).toBe(seat.toUpperCase());
    }
  });

  it("equal holds exactly the frozen Core 50, no extras, no seat", () => {
    expect(ACCOUNTS.equal.tickers).toEqual(CORE_50);
    expect(ACCOUNTS.equal.seat).toBeNull();
  });

  it("spy holds exactly IVV, no seat", () => {
    expect(ACCOUNTS.spy.tickers).toEqual(["IVV"]);
    expect(ACCOUNTS.spy.seat).toBeNull();
  });

  it("total watchlist row count is 501, not the design doc's original (incorrect) 526", () => {
    const total = ACCOUNT_IDS.reduce((n: number, id: string) => n + ACCOUNTS[id].tickers.length, 0);
    expect(total).toBe(501);
  });
});

describe("seed constants", () => {
  it("STARTING_CASH is $10,000 per account (§2)", () => {
    expect(STARTING_CASH).toBe(10000);
  });

  it("PAPER_POLICY_VERSION matches lib/shared/paper-policy.ts's exported version", async () => {
    const { PAPER_POLICY_VERSION: libVersion } = await import("@/lib/shared/paper-policy");
    expect(PAPER_POLICY_VERSION).toBe(libVersion);
  });
});
