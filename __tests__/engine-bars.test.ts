import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import constants from "@/lib/shared/hydration-constants.json";
// @ts-expect-error plain mjs helper
import { sipHistoryEnd } from "../scripts/lib/hydrate-indicators.mjs";

const source = readFileSync("scripts/engine-bars.mjs", "utf8")
  .replace(/^import .*;$/gm, "")
  .replace(/main\(\)\.catch\(.*\);/, "globalThis.done = main();");

async function run(feed: string, latest: Record<string, string>, backfill?: number) {
  const urls: URL[] = [];
  const warn = vi.fn();
  const now = new Date("2026-10-13T16:00:00Z");
  class FixedDate extends Date {
    constructor(value: string | number = now.getTime()) { super(value); }
    static now() { return now.getTime(); }
  }
  const context = {
    ...constants, sipHistoryEnd, Date: FixedDate, URL, AbortSignal,
    readFileSync: () => { throw new Error("no env file"); }, join: () => "unused",
    process: { cwd: () => "/tmp", argv: ["node", "engine-bars", `--feed=${feed}`, "--symbols=AAPL", "--dry-run", ...(backfill ? [`--backfill-days=${backfill}`] : [])], env: { PORTAL_PUSH_SECRET: "test", ALPACA_API_KEY: "test", ALPACA_API_SECRET: "test" }, exit: () => { throw new Error("unexpected exit"); } },
    console: { log: vi.fn(), error: vi.fn(), warn },
    fetch: async (url: string | URL) => {
      const parsed = new URL(url);
      if (parsed.hostname === "localhost") return { ok: true, json: async () => ({ latest }) };
      urls.push(parsed);
      return { ok: true, json: async () => ({ bars: { AAPL: [{ t: "2026-10-12T00:00:00Z", o: 1, h: 2, l: 1, c: 2, v: 10 }] }, next_page_token: urls.length === 1 ? "second" : null }) };
    }, done: Promise.resolve(),
  };
  runInNewContext(source, context);
  await context.done;
  return { urls, warn };
}

describe("engine-bars history requests", () => {
  it("bounds every SIP page and backfills when only IEX history exists", async () => {
    const { urls, warn } = await run("sip", { iex: "2026-10-12" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no stored sip bars"));
    expect(urls).toHaveLength(2);
    for (const url of urls) {
      expect(url.searchParams.get("end")).toBe("2026-10-13T15:45:00.000Z");
      expect(url.searchParams.get("start")).toBe("2025-10-13");
    }
    expect(urls[1].searchParams.get("page_token")).toBe("second");
  });
  it("keeps incremental overlap and IEX requests unbounded", async () => {
    const { urls, warn } = await run("iex", { iex: "2026-10-12" });
    expect(urls[0].searchParams.get("start")).toBe("2026-10-05");
    expect(urls[0].searchParams.has("end")).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
  it("honors an explicit backfill window", async () => {
    const { urls } = await run("sip", {}, 730);
    expect(urls[0].searchParams.get("start")).toBe("2024-10-13");
  });
});
