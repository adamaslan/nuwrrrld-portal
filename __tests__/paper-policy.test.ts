import { describe, expect, it } from "vitest";
import {
  ACCOUNT_SEAT,
  PAPER_ACCOUNTS,
  PAPER_POLICY,
  PAPER_POLICY_VERSION,
  TRADING_ACCOUNTS,
  isTradingAccount,
  policyFor,
  MAX_MODEL_CALLS_PER_RUN_ALL_ACCOUNTS,
  MAX_MODEL_CALLS_PER_DAY_ALL_ACCOUNTS,
} from "@/lib/shared/paper-policy";

describe("PAPER_ACCOUNTS / TRADING_ACCOUNTS", () => {
  it("has all eight accounts, seats first then the two controls", () => {
    expect(PAPER_ACCOUNTS).toEqual(["t1", "t2", "risk", "macro", "quant", "chair", "equal", "spy"]);
  });

  it("TRADING_ACCOUNTS matches the six council seats, no controls", () => {
    expect(TRADING_ACCOUNTS).toHaveLength(6);
    expect(TRADING_ACCOUNTS).not.toContain("equal");
    expect(TRADING_ACCOUNTS).not.toContain("spy");
  });
});

describe("ACCOUNT_SEAT", () => {
  it("maps every trading account to its uppercase CouncilSeat", () => {
    expect(ACCOUNT_SEAT.t1).toBe("T1");
    expect(ACCOUNT_SEAT.quant).toBe("QUANT");
    expect(ACCOUNT_SEAT.chair).toBe("CHAIR");
  });

  it("has an entry for every trading account and nothing else", () => {
    expect(Object.keys(ACCOUNT_SEAT).sort()).toEqual([...TRADING_ACCOUNTS].sort());
  });
});

describe("PAPER_POLICY", () => {
  it("has a vector for every trading account", () => {
    for (const account of TRADING_ACCOUNTS) {
      expect(PAPER_POLICY[account]).toBeDefined();
    }
  });

  it("quant makes zero model calls by construction (§3)", () => {
    expect(PAPER_POLICY.quant.maxModelCallsPerRun).toBe(0);
  });

  it("risk has the tightest cash floor and position cap (the persona is the risk controls)", () => {
    const risk = PAPER_POLICY.risk;
    for (const account of TRADING_ACCOUNTS) {
      if (account === "risk") continue;
      expect(risk.cashFloor).toBeGreaterThanOrEqual(PAPER_POLICY[account].cashFloor);
      expect(risk.maxPositionWeight).toBeLessThanOrEqual(PAPER_POLICY[account].maxPositionWeight);
    }
  });

  it("macro has the widest sector cap (rotation is the thesis)", () => {
    const macro = PAPER_POLICY.macro.sectorCapPct;
    for (const account of TRADING_ACCOUNTS) {
      expect(macro).toBeGreaterThanOrEqual(PAPER_POLICY[account].sectorCapPct);
    }
  });

  it("t2 has the longest minimum holding period (matches a multi-year mandate)", () => {
    const t2 = PAPER_POLICY.t2.minHoldingPeriodRuns;
    for (const account of TRADING_ACCOUNTS) {
      expect(t2).toBeGreaterThanOrEqual(PAPER_POLICY[account].minHoldingPeriodRuns);
    }
  });

  it("every buyThreshold is strictly above its own sellThreshold (no account can buy what it would immediately sell)", () => {
    for (const account of TRADING_ACCOUNTS) {
      expect(PAPER_POLICY[account].buyThreshold).toBeGreaterThan(PAPER_POLICY[account].sellThreshold);
    }
  });
});

describe("isTradingAccount / policyFor", () => {
  it("recognizes the six trading accounts and rejects the two controls", () => {
    for (const account of TRADING_ACCOUNTS) expect(isTradingAccount(account)).toBe(true);
    expect(isTradingAccount("equal")).toBe(false);
    expect(isTradingAccount("spy")).toBe(false);
  });

  it("returns null for equal/spy — they never trade after seed", () => {
    expect(policyFor("equal")).toBeNull();
    expect(policyFor("spy")).toBeNull();
  });

  it("returns the matching vector for a trading account", () => {
    expect(policyFor("quant")).toBe(PAPER_POLICY.quant);
  });
});

describe("model-call ceilings (§4.2)", () => {
  it("per-run ceiling times three trading slots does not exceed the daily ceiling (settle makes none)", () => {
    expect(MAX_MODEL_CALLS_PER_RUN_ALL_ACCOUNTS * 3).toBeLessThanOrEqual(
      MAX_MODEL_CALLS_PER_DAY_ALL_ACCOUNTS,
    );
  });

  it("the sum of every account's per-run cap does not exceed the all-accounts run ceiling", () => {
    const sum = TRADING_ACCOUNTS.reduce((n, account) => n + PAPER_POLICY[account].maxModelCallsPerRun, 0);
    expect(sum).toBeLessThanOrEqual(MAX_MODEL_CALLS_PER_RUN_ALL_ACCOUNTS);
  });
});

describe("PAPER_POLICY_VERSION", () => {
  it("is a non-empty string", () => {
    expect(typeof PAPER_POLICY_VERSION).toBe("string");
    expect(PAPER_POLICY_VERSION.length).toBeGreaterThan(0);
  });
});
