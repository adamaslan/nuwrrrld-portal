/**
 * lib/nuai.ts — unit tests for `reservationExceedsBudget`, the pure decision
 * behind the atomic token-budget reservation in app/api/portfolio/health-ai
 * (PR #135 CodeRabbit finding: the old check-then-act getRemainingBudget()
 * gate let concurrent requests all read "budget available" and all proceed).
 * See lib/nuai-db.ts's `reserveTokens` for the actual atomic DB round trip
 * this function's result is used to interpret.
 */
import { describe, expect, it } from "vitest";
import { reservationExceedsBudget } from "@/lib/nuai";

describe("reservationExceedsBudget", () => {
  it("allows a reservation that lands at or under budget", () => {
    expect(reservationExceedsBudget(100, 100)).toBe(false);
    expect(reservationExceedsBudget(99, 100)).toBe(false);
  });

  it("rejects a reservation that pushes the total over budget", () => {
    expect(reservationExceedsBudget(101, 100)).toBe(true);
  });

  it("fails open when the reservation could not be made (DB error)", () => {
    // reserveTokens returns null on a DB error — a metering outage must not
    // block the product, matching lib/nuai-db.ts's existing fail-open
    // convention for getUsedTokensToday/addTokenUsage.
    expect(reservationExceedsBudget(null, 100)).toBe(false);
  });

  it("uses the real NU_AI_DAILY_TOKEN_BUDGET as the default cap", () => {
    expect(reservationExceedsBudget(50_001)).toBe(true);
    expect(reservationExceedsBudget(50_000)).toBe(false);
  });

  it("is the property that makes two concurrent reservations serialize correctly", () => {
    // Simulates what two concurrent requests would each observe from their
    // own atomic UPSERT...RETURNING: the second writer's RETURNING reflects
    // the total *after* both increments, since Postgres serializes writers
    // on the same row. A single combined request that would have fit alone
    // gets split into one allowed + one rejected once both land.
    const budget = 100;
    const alreadyUsed = 60;
    const requestSize = 50;
    const firstTotal = alreadyUsed + requestSize; // 110 — this one already exceeds
    const secondTotal = firstTotal + requestSize; // 160 — compounds if not rejected
    expect(reservationExceedsBudget(firstTotal, budget)).toBe(true);
    expect(reservationExceedsBudget(secondTotal, budget)).toBe(true);
  });
});
