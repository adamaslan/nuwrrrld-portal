import { describe, expect, it } from "vitest";
import { parseTickerCsv } from "@/lib/watchlist-csv";

describe("parseTickerCsv", () => {
  it("reads a one-column list with no header", () => {
    expect(parseTickerCsv("AAPL\nMSFT\n")).toEqual(["AAPL", "MSFT"]);
  });

  it("reads the ticker column by header name, wherever it sits", () => {
    expect(parseTickerCsv("name,ticker,qty\nApple,AAPL,10\nMicrosoft,MSFT,5")).toEqual(["AAPL", "MSFT"]);
  });

  it("accepts a symbol header and mixed-case header names", () => {
    expect(parseTickerCsv("Symbol\naapl")).toEqual(["aapl"]);
  });

  it("strips a UTF-8 BOM and handles CRLF line endings", () => {
    expect(parseTickerCsv("﻿ticker\r\nAAPL\r\nMSFT\r\n")).toEqual(["AAPL", "MSFT"]);
  });

  it("skips blank lines and # comment lines", () => {
    expect(parseTickerCsv("# my list\n\nAAPL\n   \n# note\nMSFT")).toEqual(["AAPL", "MSFT"]);
  });

  it("keeps commas inside quoted fields", () => {
    expect(parseTickerCsv('ticker,note\nAAPL,"big, long-term"\nMSFT,plain')).toEqual(["AAPL", "MSFT"]);
    expect(parseTickerCsv('name,ticker\n"Apple, Inc.",AAPL')).toEqual(["AAPL"]);
  });

  it("unescapes doubled quotes inside quoted fields", () => {
    expect(parseTickerCsv('ticker,note\n"AAPL","says ""buy"""')).toEqual(["AAPL"]);
  });

  it("keeps a newline inside a quoted field within the same row", () => {
    expect(parseTickerCsv('ticker,note\nAAPL,"line one\nline two"\nMSFT,x')).toEqual(["AAPL", "MSFT"]);
  });

  it("strips surrounding quotes from a quoted ticker", () => {
    expect(parseTickerCsv('"AAPL"\n"MSFT"')).toEqual(["AAPL", "MSFT"]);
  });

  it("returns empty input as an empty list", () => {
    expect(parseTickerCsv("")).toEqual([]);
    expect(parseTickerCsv("\n\n# only a comment\n")).toEqual([]);
  });

  it("leaves a blank ticker cell as an empty string for the server to reject", () => {
    expect(parseTickerCsv("ticker\nAAPL\n\n,x\nMSFT")).toEqual(["AAPL", "", "MSFT"]);
  });
});
