import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { newYorkDate, sipHistoryEnd, intradaySessionOpen } from "../scripts/lib/hydrate-indicators.mjs";
import * as indicators from "../scripts/lib/hydrate-indicators.mjs";
import constants from "../lib/shared/hydration-constants.json";

describe("hydration exchange time", () => {
  it("labels a late UTC run with the prior New York session", () => {
    expect(newYorkDate("2026-10-13T03:07:00Z")).toBe("2026-10-12");
    expect(newYorkDate("2026-10-12T04:00:00Z")).toBe("2026-10-12");
  });
  it("converts daily bar timestamps across summer and winter offsets", () => {
    expect(newYorkDate("2026-07-06T04:00:00Z")).toBe("2026-07-06");
    expect(newYorkDate("2026-01-06T05:00:00Z")).toBe("2026-01-06");
    expect(() => newYorkDate("invalid")).toThrow("Invalid bar timestamp");
  });
  it("ends SIP requests fifteen minutes before the request", () => {
    expect(sipHistoryEnd("2026-10-12T20:05:00Z", constants.SIP_DELAY_MINUTES))
      .toBe("2026-10-12T19:50:00.000Z");
    expect(constants.ALPACA_FEED).toBe("sip");
    expect(constants.FETCH_CHUNK_SIZE).toBe(150);
    expect(constants.CHUNK_SIZE).toBe(35);
  });
  it("rejects closed, stale and malformed clocks, including an early close", () => {
    const now = new Date("2026-11-27T18:01:00Z");
    expect(intradaySessionOpen({ is_open: false, timestamp: now.toISOString(), next_close: "2026-11-30T21:00:00Z" }, now)).toBe(false);
    expect(intradaySessionOpen({ is_open: true, timestamp: now.toISOString(), next_close: "2026-11-27T18:00:00Z" }, now)).toBe(false);
    expect(intradaySessionOpen({ is_open: true, timestamp: "2026-11-27T17:50:00Z", next_close: "2026-11-27T21:00:00Z" }, now)).toBe(false);
    expect(intradaySessionOpen({}, now)).toBe(false);
  });
  it("allows a fresh clock during the actual exchange session", () => {
    const now = new Date("2026-11-27T17:59:00Z");
    expect(intradaySessionOpen({ is_open: true, timestamp: now.toISOString(), next_close: "2026-11-27T18:00:00Z" }, now)).toBe(true);
  });
});


describe("hydration runner failure finalization", () => {
  it("finalizes failed fetches with valid run items and reports a failed status", async () => {
    const script = readFileSync(new URL("../scripts/hydrate-local.mjs", import.meta.url), "utf8")
      .replace(/^#!.*\n/, "")
      .replace(/^import[\s\S]*?;$/gm, "")
      .replace(/main\(\)\.catch\([\s\S]*$/, "await main();");
    const requests: Record<string, unknown>[] = [];
    const logs: string[] = [];
    const fakeProcess = {
      argv: ["node", "hydrate-local", "--symbols=AAPL"],
      env: { PORTAL_PUSH_SECRET: "test", ALPACA_API_KEY: "test", ALPACA_API_SECRET: "test" },
      cwd: () => "/unused", exitCode: 0,
    };
    let budgetCalls = 0;
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const execute = new AsyncFunction("process", "readFileSync", "join", "fetch", "console", "newYorkDate", "acquireAlpacaBudget", "MIN_BARS", "LOOKBACK_DAYS", "FETCH_CHUNK_SIZE", "CHUNK_SIZE", "sipHistoryEnd", "SIP_DELAY_MINUTES", "ALPACA_PAGE_LIMIT", "ALPACA_FEED", "ALPACA_ADJUSTMENT", script);
    await execute(fakeProcess, () => { throw new Error("no credential files"); }, () => "/unused",
      async (_url: unknown, init?: { body?: string }) => {
        if (!init?.body) return { ok: true, json: async () => ({ bars: {} }) };
        const body = JSON.parse(init.body);
        requests.push(body);
        return { ok: true, json: async () => ({ status: "fail", logged: true }) };
      }, { log: (line: string) => logs.push(line), warn: () => {}, error: () => {} },
      newYorkDate, async () => { budgetCalls++; throw new Error("budget unavailable"); }, 40, 365, 150, 35, sipHistoryEnd, 15, 10000, "sip", "split");
    expect(budgetCalls).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0].complete).toBe(true);
    expect(requests[0].items).toEqual([{ subject: "AAPL", model: null, outcome: "fail" }]);
    expect(fakeProcess.exitCode).toBe(1);
    expect(logs.some(line => line.includes("[done] status=fail"))).toBe(true);
  });
});


type TestBar = { t: string; o: number; h: number; l: number; c: number; v: number };

describe("hydration runner stored history and transport", () => {
  it.each([false, true])("reuses warm history and separates fetch/POST batches (mixed cold=%s)", async mixedCold => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-13T03:07:00Z"));
    try {
      const symbols = mixedCold ? ["WARM", "COLD"] : Array.from({ length: 151 }, (_, i) => `T${i}`);
      const history: TestBar[] = Array.from({ length: 40 }, (_, i) => ({
        t: new Date(Date.parse("2026-10-09T12:00:00Z") - (39 - i) * 86_400_000).toISOString(),
        o: 100 + i, h: 102 + i, l: 99 + i, c: 101 + i, v: 1000,
      }));
      const latest: TestBar = { t: "2026-10-12T04:00:00Z", o: 140, h: 143, l: 139, c: 142, v: 1000 };
      const vendorRequests: URL[] = [];
      const posts: { complete?: boolean; barDate: string; rows: { ticker: string; barDate: string; status: string; frameStats: { barCount: number } }[] }[] = [];
      const cached = Object.fromEntries(symbols.filter(s => s !== "COLD").map(s => [s, history]));
      const fakeProcess = { argv: ["node", "hydrate-local", `--symbols=${symbols.join(",")}`],
        env: { PORTAL_PUSH_SECRET: "test", ALPACA_API_KEY: "test", ALPACA_API_SECRET: "test" },
        cwd: () => "/unused", exitCode: 0 };
      let budgetCalls = 0;
      const dependencies = { process: fakeProcess, readFileSync: () => { throw new Error("no credential files"); },
        join: () => "/unused", console: { log: () => {}, warn: () => {}, error: () => {} },
        ...indicators, ...constants, acquireAlpacaBudget: async () => { budgetCalls++; },
        fetch: async (input: URL | string, init?: { body?: string }) => {
          const url = new URL(input);
          if (url.hostname === "data.alpaca.markets") {
            vendorRequests.push(url);
            const requested = url.searchParams.get("symbols")!.split(",");
            return { ok: true, json: async () => ({ bars: Object.fromEntries(requested.map(symbol =>
              [symbol, symbol === "COLD" ? [...history, latest] : [latest]])), next_page_token: null }) };
          }
          if (!init?.body) return { ok: true, json: async () => ({ bars: cached }) };
          const body = JSON.parse(init.body);
          posts.push(body);
          return { ok: true, json: async () => body.complete ? { status: "ok", logged: true } :
            { written: body.rows.length, failed: 0, skipped: 0, runItems: [] } };
        } };
      const script = readFileSync(new URL("../scripts/hydrate-local.mjs", import.meta.url), "utf8")
        .replace(/^#!.*\n/, "").replace(/^import[\s\S]*?;$/gm, "")
        .replace(/main\(\)\.catch\([\s\S]*$/, "await main();");
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      await new AsyncFunction(...Object.keys(dependencies), script)(...Object.values(dependencies));
      expect(budgetCalls).toBe(vendorRequests.length);
      expect(vendorRequests).toHaveLength(2);
      for (const request of vendorRequests) {
        expect(request.searchParams.get("feed")).toBe("sip");
        expect(request.searchParams.get("end")).toBe("2026-10-13T02:52:00.000Z");
      }
      if (mixedCold) {
        expect(vendorRequests[0].searchParams.get("symbols")).toBe("WARM");
        expect(vendorRequests[0].searchParams.get("start")).toBe("2026-10-09");
        expect(vendorRequests[1].searchParams.get("symbols")).toBe("COLD");
        expect(vendorRequests[1].searchParams.get("start")).toBe("2025-10-12");
      } else {
        expect(vendorRequests.map(url => url.searchParams.get("symbols")!.split(",").length)).toEqual([150, 1]);
        expect(vendorRequests.every(url => url.searchParams.get("start") === "2026-10-09")).toBe(true);
        expect(posts.filter(post => !post.complete).map(post => post.rows.length)).toEqual([35, 35, 35, 35, 10, 1]);
      }
      const rows = posts.flatMap(post => post.rows);
      expect(rows).toHaveLength(symbols.length);
      expect(rows.every(row => row.status === "ok" && row.barDate === "2026-10-12" && row.frameStats.barCount === 41)).toBe(true);
      expect(posts.every(post => post.barDate === "2026-10-12")).toBe(true);
      expect(posts.filter(post => post.complete)).toHaveLength(1);
      expect(fakeProcess.exitCode).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("late intraday runner", () => {
  it("skips a closed exchange before universe reads or card writes", async () => {
    const requests: string[] = [];
    const logs: string[] = [];
    const dependencies = {
      process: { argv: ["node", "hydrate-local", "--intraday"],
        env: { PORTAL_PUSH_SECRET: "test", ALPACA_API_KEY: "test", ALPACA_API_SECRET: "test" }, cwd: () => "/unused" },
      readFileSync: () => { throw new Error("no credential files"); }, join: () => "/unused",
      ...indicators, ...constants, acquireAlpacaBudget: async () => {},
      console: { log: (line: string) => logs.push(line), warn: () => {}, error: () => {} },
      fetch: async (input: URL | string) => {
        requests.push(String(input));
        return { ok: true, json: async () => ({ is_open: false }) };
      },
    };
    const script = readFileSync(new URL("../scripts/hydrate-local.mjs", import.meta.url), "utf8")
      .replace(/^#!.*\n/, "").replace(/^import[\s\S]*?;$/gm, "")
      .replace(/main\(\)\.catch\([\s\S]*$/, "await main();");
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    await new AsyncFunction(...Object.keys(dependencies), script)(...Object.values(dependencies));
    expect(requests).toEqual(["https://paper-api.alpaca.markets/v2/clock"]);
    expect(logs.some(line => line.includes("[done] status=skipped"))).toBe(true);
  });
});
