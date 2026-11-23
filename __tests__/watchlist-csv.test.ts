import { describe, expect, it } from "vitest";
import { MAX_CSV_FILE_BYTES, CSV_FILE_TOO_LARGE_ERROR, getCsvFileSizeError, UNTERMINATED_QUOTE_ERROR, parseTickerCsv, parseTickerCsvChecked } from "@/lib/watchlist-csv";

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

describe("malformed and legacy input", () => {
  it("treats a lone CR (classic Mac export) as a row break", () => {
    expect(parseTickerCsv("ticker\rAAPL\rMSFT")).toEqual(["AAPL", "MSFT"]);
  });

  it("reports an unterminated quote instead of swallowing the rest of the file", () => {
    const r = parseTickerCsvChecked('ticker\nAAPL\n"MSFT\nGOOG\nNVDA');
    expect(r.error).toBe(UNTERMINATED_QUOTE_ERROR);
    expect(r.tickers).toEqual([]);
  });

  it("fails closed from the legacy wrapper on an unterminated quote", () => {
    expect(parseTickerCsv('AAPL\n"MSFT\nGOOG')).toEqual([]);
  });

  it("does not flag a closed quote at end of file", () => {
    expect(parseTickerCsvChecked('ticker\nAAPL\n"MSFT"')).toEqual({ tickers: ["AAPL", "MSFT"], error: null });
  });

  it("keeps a mid-field quote literal rather than opening a quoted run", () => {
    expect(parseTickerCsvChecked('ticker\nAA"PL\nMSFT')).toEqual({ tickers: ['AA"PL', "MSFT"], error: null });
  });

  it("returns a header-only file as no tickers without an error", () => {
    expect(parseTickerCsvChecked("ticker\n")).toEqual({ tickers: [], error: null });
  });
});


describe("portfolio CSV file-size allowance", () => {
  it("uses the requested 1 MB byte limit", () => {
    expect(MAX_CSV_FILE_BYTES).toBe(1024 * 1024);
  });

  it("accepts files above the old 64 KB limit and through exactly 1 MB", () => {
    for (const size of [0, 64 * 1024 + 1, MAX_CSV_FILE_BYTES - 1, MAX_CSV_FILE_BYTES]) {
      expect(getCsvFileSizeError(size)).toBeNull();
    }
  });

  it("rejects one byte above 1 MB with the matching user-facing error", () => {
    expect(getCsvFileSizeError(MAX_CSV_FILE_BYTES + 1)).toBe(CSV_FILE_TOO_LARGE_ERROR);
    expect(CSV_FILE_TOO_LARGE_ERROR).toBe("File too large (max 1 MB).");
  });

  it("parses a CSV larger than the old allowance without changing ticker extraction", () => {
    const text = 'ticker,note\nAAPL,"' + 'x'.repeat(70 * 1024) + '"';
    expect(getCsvFileSizeError(new TextEncoder().encode(text).length)).toBeNull();
    expect(parseTickerCsvChecked(text)).toEqual({ tickers: ["AAPL"], error: null });
  });
});
