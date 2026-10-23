import { describe, expect, it, vi } from "vitest";
import { acquireAlpacaBudget } from "../lib/alpaca-budget.mjs";

const exhausted = () => Object.assign(new Error("budget exhausted"), { name: "ConditionalCheckFailedException" });

describe("Alpaca minute budget waiting", () => {
  it("waits to the next minute and reserves a fresh bucket before fetching", async () => {
    let now = Date.parse("2026-10-13T14:32:59Z");
    const updateItem = vi.fn().mockRejectedValueOnce(exhausted()).mockResolvedValue({});
    const wait = vi.fn(async (delay: number) => { now += delay; });
    const vendor = vi.fn();
    await acquireAlpacaBudget({ now, clock: () => now, wait, updateItem });
    vendor();
    expect(wait).toHaveBeenCalledExactlyOnceWith(1000);
    expect(updateItem.mock.calls.map(([input]) => input.Key.bucket.S)).toEqual([
      "alpaca#2026-10-13T14:32", "alpaca#2026-10-13T14:33",
    ]);
    expect(vendor).toHaveBeenCalledOnce();
  });

  it("fails closed after three minute-boundary retries", async () => {
    let now = Date.parse("2026-10-13T14:32:00Z");
    const updateItem = vi.fn().mockRejectedValue(exhausted());
    const wait = vi.fn(async (delay: number) => { now += delay; });
    const vendor = vi.fn();
    await expect((async () => {
      await acquireAlpacaBudget({ now, clock: () => now, wait, updateItem });
      vendor();
    })()).rejects.toThrow("budget exhausted");
    expect(wait).toHaveBeenCalledTimes(3);
    expect(updateItem).toHaveBeenCalledTimes(4);
    expect(vendor).not.toHaveBeenCalled();
  });

  it("does not wait or fetch on DynamoDB errors, including after a capacity retry", async () => {
    let now = Date.parse("2026-10-13T14:32:59Z");
    const failure = new Error("budget unavailable");
    const updateItem = vi.fn().mockRejectedValueOnce(exhausted()).mockRejectedValue(failure);
    const wait = vi.fn(async (delay: number) => { now += delay; });
    await expect(acquireAlpacaBudget({ now, clock: () => now, wait, updateItem })).rejects.toBe(failure);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(updateItem).toHaveBeenCalledTimes(2);
  });
});
