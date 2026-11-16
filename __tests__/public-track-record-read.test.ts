import { beforeEach, describe, expect, it, vi } from "vitest";
const { getAllScores } = vi.hoisted(() => ({ getAllScores: vi.fn() }));
vi.mock("@/lib/followed-tickers-db", () => ({ getAllScores }));
import { getPublicTrackRecord } from "@/lib/public-track-record-db";

describe("public scoreboard availability", () => {
  beforeEach(() => { getAllScores.mockReset(); });
  it("distinguishes a successful empty read", async () => {
    getAllScores.mockResolvedValue([]);
    expect(await getPublicTrackRecord()).toEqual({ status: "empty", record: null });
    expect(getAllScores).toHaveBeenCalledWith({ throwOnError: true });
  });
  it("does not describe a failed read as an empty dataset", async () => {
    getAllScores.mockRejectedValue(new Error("offline"));
    expect(await getPublicTrackRecord()).toEqual({ status: "unavailable", record: null });
  });
  it("preserves scored counts when available", async () => {
    getAllScores.mockResolvedValue([{ horizon: "d1", outcome: "miss", directional: -2, resolvedOn: "2026-11-12" }]);
    expect(await getPublicTrackRecord()).toMatchObject({ status: "ready", record: { totalScored: 1, latestResolvedOn: "2026-11-12" } });
  });
});
