import { describe, expect, it } from "vitest";

import { isUnservableRow } from "@/lib/shared/hydrate-rows";
import { unservableRow } from "../scripts/lib/hydrate-indicators.mjs";

describe("isUnservableRow", () => {
  it("is true for an error tagged unservable", () => {
    expect(isUnservableRow({ status: "error", errorKind: "unservable" })).toBe(true);
  });

  it("is false for an error with no errorKind (older hosts stay upstream errors)", () => {
    expect(isUnservableRow({ status: "error" })).toBe(false);
  });

  it("is false for errorKind compute", () => {
    expect(isUnservableRow({ status: "error", errorKind: "compute" })).toBe(false);
  });

  it("is false for ok rows and nullish input", () => {
    expect(isUnservableRow({ status: "ok", errorKind: "unservable" })).toBe(false);
    expect(isUnservableRow(undefined)).toBe(false);
  });
});

describe("unservableRow (hydrate-local rowFor gate)", () => {
  it("tags undefined and empty bars as unservable", () => {
    for (const bars of [undefined, []]) {
      expect(unservableRow("AMKBY", bars)).toEqual({
        ticker: "AMKBY",
        status: "error",
        error: "no vendor bars",
        errorKind: "unservable",
      });
    }
  });

  it("returns null for a short but non-empty history", () => {
    const bars = Array.from({ length: 5 }, () => ({ t: "2026-10-01", c: 1, h: 1, l: 1 }));
    expect(unservableRow("NEW", bars)).toBeNull();
  });
});

import { settleUnservable, unservableWithinCeiling } from "@/lib/shared/hydrate-rows";

describe("unservableWithinCeiling", () => {
  it("allows none and a few dead symbols", () => {
    expect(unservableWithinCeiling(0, 35)).toBe(true);
    expect(unservableWithinCeiling(2, 35)).toBe(true);
    expect(unservableWithinCeiling(5, 35)).toBe(true);
  });
  it("rejects a share that looks like an outage", () => {
    expect(unservableWithinCeiling(6, 35)).toBe(false);
    expect(unservableWithinCeiling(35, 35)).toBe(false);
  });
  it("scales the allowance with large requests", () => {
    expect(unservableWithinCeiling(120, 800)).toBe(true);
    expect(unservableWithinCeiling(121, 800)).toBe(false);
  });
});

describe("settleUnservable", () => {
  it("leaves both arrays alone within the ceiling", () => {
    const unservable = ["A", "B"];
    const upstream = ["X"];
    settleUnservable(unservable, upstream, 35);
    expect(unservable).toEqual(["A", "B"]);
    expect(upstream).toEqual(["X"]);
  });
  it("moves every unservable entry into upstream errors above the ceiling", () => {
    const unservable = ["A", "B", "C", "D", "E", "F"];
    const upstream = ["X"];
    settleUnservable(unservable, upstream, 35);
    expect(unservable).toEqual([]);
    expect(upstream).toEqual(["X", "A", "B", "C", "D", "E", "F"]);
  });
});
