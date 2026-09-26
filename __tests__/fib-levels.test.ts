import { describe, expect, it } from "vitest";
import { buildFibLadder, type FibLevel } from "@/lib/shared/fib-levels";

const level = (name: string, price: number, spot: number): FibLevel => ({
  name,
  price,
  distance_pct: ((price - spot) / spot) * 100,
  strength: "medium",
  type: "retracement",
});

const SPOT = 150;

describe("buildFibLadder", () => {
  it("returns null with no levels", () => {
    expect(buildFibLadder({})).toBeNull();
    expect(buildFibLadder({ fib_levels: [] })).toBeNull();
  });

  it("orders rows high to low with the price marker between support and resistance", () => {
    const ladder = buildFibLadder({
      fib_levels: [level("0.618", 138, SPOT), level("0.382", 162, SPOT), level("0.5", 148, SPOT)],
      nearest_fib_support: 148,
      nearest_fib_resistance: 162,
    })!;
    const prices = ladder.rows.map((r) => r.price);
    expect(prices).toEqual([...prices].sort((a, b) => b - a));
    const marker = ladder.rows.findIndex((r) => r.kind === "price");
    expect(ladder.rows[marker].price).toBeCloseTo(SPOT, 6);
    expect(ladder.rows[marker - 1].price).toBe(162);
    expect(ladder.rows[marker + 1].price).toBe(148);
    expect(ladder.support?.price).toBe(148);
    expect(ladder.resistance?.price).toBe(162);
  });

  it("keeps the levels nearest to price, not the first in registry order", () => {
    const far = Array.from({ length: 8 }, (_, i) => level(`far${i}`, 300 + i, SPOT));
    const near = [level("nearA", 149, SPOT), level("nearB", 152, SPOT)];
    const ladder = buildFibLadder({ fib_levels: [...far, ...near] })!;
    const names = ladder.rows.flatMap((r) => (r.kind === "level" ? [r.name] : []));
    expect(names).toContain("nearA");
    expect(names).toContain("nearB");
    expect(names).toHaveLength(6);
  });

  it("returns the top 3 confluence zones by score", () => {
    const zone = (price: number, score: number) => ({ price, strength: "s", signal_count: 2, confluence_score: score });
    const ladder = buildFibLadder({
      fib_levels: [level("0.5", 148, SPOT)],
      fib_confluence_zones: [zone(1, 1), zone(2, 9), zone(3, 5), zone(4, 7)],
    })!;
    expect(ladder.zones.map((z) => z.price)).toEqual([2, 4, 3]);
  });

  it("ignores non-finite levels", () => {
    expect(buildFibLadder({ fib_levels: [{ ...level("x", 100, SPOT), price: NaN }] })).toBeNull();
  });
});
