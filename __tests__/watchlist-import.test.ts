import { describe, expect, it } from "vitest";
import {
  ImportHttpError,
  MAX_IMPORT_ROWS,
  MAX_WATCHLIST_SIZE,
  checkRequestOrigin,
  classifyFormat,
  isJsonContentType,
  parseImportBody,
  readJsonCapped,
  resolveAgainstUniverse,
} from "@/lib/watchlist-import";
import { MAX_CSV_IMPORT_ROWS, getCsvRowCountError, getCsvImportResponseError, CSV_TOO_MANY_ROWS_ERROR, parseTickerCsv } from "@/lib/watchlist-csv";

const status = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as ImportHttpError).status;
  }
  return 0;
};

const streamOf = (text: string, chunk = 1024) => {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += chunk) c.enqueue(bytes.slice(i, i + chunk));
      c.close();
    },
  });
};

describe("parseImportBody", () => {
  it("accepts a plain ticker array", () => {
    expect(parseImportBody({ tickers: ["aapl"], dryRun: true })).toEqual({ tickers: ["aapl"], dryRun: true });
  });
  it.each([
    [null], [[]], ["x"], [{}], [{ tickers: "AAPL" }], [{ tickers: [1] }], [{ tickers: [["A"]] }],
    [{ tickers: [{}] }], [{ tickers: ["A".repeat(17)] }], [{ tickers: ["A"], dryRun: "yes" }],
  ])("rejects malformed shape %#", (body) => {
    expect(status(() => parseImportBody(body))).toBe(400);
  });
  it("rejects over-row-limit with 413", () => {
    const tickers = Array.from({ length: MAX_IMPORT_ROWS + 1 }, () => "A");
    expect(status(() => parseImportBody({ tickers }))).toBe(413);
  });
  it("ignores user-id style extra keys", () => {
    expect(parseImportBody({ tickers: ["A"], userId: "victim" })).toEqual({ tickers: ["A"], dryRun: false });
  });
});

describe("classifyFormat", () => {
  it("normalizes and dedupes", () => {
    expect(classifyFormat([" aapl", "AAPL", "msft"]).candidates).toEqual(["AAPL", "MSFT"]);
  });
  it.each([
    "=CMD|' /C calc'!A0", "<script>", "'; DROP TABLE x;--", "AAPL\nMSFT", "", "1ABC", "-AAPL", "@SUM(A1)",
  ])("rejects hostile value %j as invalid", (v) => {
    const r = classifyFormat([v]);
    expect(r.candidates).toEqual([]);
    expect(r.invalid).toBe(1);
  });
  it("flags crypto pairs", () => {
    const r = classifyFormat(["BTC-USD", "AAPL"]);
    expect(r.cryptoUnsupported).toBe(1);
    expect(r.candidates).toEqual(["AAPL"]);
  });
});

describe("resolveAgainstUniverse", () => {
  const universe = new Set(["AAPL", "BRK.B"]);
  it("maps hyphen to dot only when the dotted form exists", () => {
    const r = resolveAgainstUniverse(["AAPL", "BRK-B", "RDS-A", "ZZZZ"], universe);
    expect(r.accepted.sort()).toEqual(["AAPL", "BRK.B"]);
    expect(r.unknown.sort()).toEqual(["RDS-A", "ZZZZ"]);
  });
});

describe("checkRequestOrigin / content type", () => {
  const h = (o: Record<string, string>) => new Headers(o);
  const allow = ["https://app.example"];
  it("blocks foreign origin and cross-site fetches", () => {
    expect(checkRequestOrigin(h({ origin: "https://evil.example" }), allow)).toBe("origin_not_allowed");
    expect(checkRequestOrigin(h({ "sec-fetch-site": "cross-site" }), allow)).toBe("cross_site");
  });
  it("allows same origin and header-less clients", () => {
    expect(checkRequestOrigin(h({ origin: "https://app.example" }), allow)).toBeNull();
    expect(checkRequestOrigin(h({}), allow)).toBeNull();
  });
  it("requires application/json exactly", () => {
    expect(isJsonContentType(h({ "content-type": "application/json; charset=utf-8" }))).toBe(true);
    expect(isJsonContentType(h({ "content-type": "text/plain" }))).toBe(false);
    expect(isJsonContentType(h({}))).toBe(false);
  });
});

describe("readJsonCapped", () => {
  it("parses a small body", async () => {
    expect(await readJsonCapped(streamOf('{"tickers":["A"]}'))).toEqual({ tickers: ["A"] });
  });
  it("aborts a streamed body over the cap with 413", async () => {
    await expect(readJsonCapped(streamOf("x".repeat(5000), 100), 1000)).rejects.toMatchObject({ status: 413 });
  });
  it("400s on bad JSON, invalid UTF-8, and missing body", async () => {
    await expect(readJsonCapped(streamOf("{nope"))).rejects.toMatchObject({ status: 400 });
    await expect(readJsonCapped(null)).rejects.toMatchObject({ status: 400 });
    const bad = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([0xff, 0xfe])); c.close(); } });
    await expect(readJsonCapped(bad)).rejects.toMatchObject({ status: 400 });
  });
});

describe("parseTickerCsv", () => {
  it("reads the ticker column by header, ignoring BOM and quotes", () => {
    expect(parseTickerCsv('﻿name,Symbol\r\n"Apple",\"AAPL\"\r\nMicrosoft,MSFT\r\n')).toEqual(["AAPL", "MSFT"]);
  });
  it("falls back to column 0 and skips blanks and comments", () => {
    expect(parseTickerCsv("# my list\nAAPL\n\nMSFT,extra\n")).toEqual(["AAPL", "MSFT"]);
  });
  it("returns [] for empty input", () => {
    expect(parseTickerCsv("")).toEqual([]);
  });
});


describe("4000-row portfolio CSV allowance", () => {
  it("shares the 4000-row limit across client and server without widening watchlist capacity", () => {
    expect(MAX_CSV_IMPORT_ROWS).toBe(4000);
    expect(MAX_IMPORT_ROWS).toBe(MAX_CSV_IMPORT_ROWS);
    expect(MAX_WATCHLIST_SIZE).toBe(1500);
    expect(CSV_TOO_MANY_ROWS_ERROR).toBe("Too many rows (limit 4000).");
  });
  it.each([501, 3999, 4000])("accepts %i raw rows through both guards", (count) => {
    const tickers = Array.from({ length: count }, () => "AAPL");
    expect(getCsvRowCountError(count)).toBeNull();
    expect(parseImportBody({ tickers }).tickers).toHaveLength(count);
  });
  it("rejects 4001 before processing", () => {
    expect(getCsvRowCountError(4001)).toBe(CSV_TOO_MANY_ROWS_ERROR);
    expect(status(() => parseImportBody({ tickers: Array(4001).fill("AAPL") }))).toBe(413);
  });
  it("reads 4000 escaped maximum-length raw entries within the bounded request envelope", async () => {
    const tickers = Array(4000).fill("\\".repeat(16));
    const body = JSON.stringify({ tickers, dryRun: true });
    expect(parseImportBody(await readJsonCapped(streamOf(body))).tickers).toHaveLength(4000);
  });
  it("retains a finite request cap", async () => {
    await expect(readJsonCapped(streamOf("x".repeat(512 * 1024 + 1)))).rejects.toMatchObject({ status: 413 });
  });
});


describe("CSV import response errors", () => {
  it("distinguishes security failures and row/body limits without echoing server text", () => {
    expect(getCsvImportResponseError(403, "origin_not_allowed")).toContain("security check");
    expect(getCsvImportResponseError(413, "too_many_rows")).toBe("Too many rows (limit 4000).");
    expect(getCsvImportResponseError(413, "body_too_large")).toContain("request is too large");
    expect(getCsvImportResponseError(413)).not.toContain("rows");
    expect(getCsvImportResponseError(503, "private backend detail")).not.toContain("private backend detail");
  });
  it.each([200, 201])("accepts success status %i", status => {
    expect(getCsvImportResponseError(status)).toBeNull();
  });
  it.each([[401, "Sign in again"], [422, "watchlist size limit"], [429, "Too many imports"]])("maps status %i", (status, message) => {
    expect(getCsvImportResponseError(status as number)).toContain(message);
  });
});
