import { describe, expect, it } from "vitest";
import {
  getCsvFileSizeError,
  getCsvRowCountError,
  parseTickerCsvChecked,
  prepareCsvSymbolPreview,
} from "@/lib/watchlist-csv";
import { MAX_RAW_TICKER_LENGTH, classifyFormat, parseImportBody } from "@/lib/watchlist-import";

// Synthetic broker lot-level export: one row per purchase lot per account, with
// padded OCC option symbols and a CUSIP mixed in with ordinary equity tickers.
const HEADER = "Account,Symbol,Description,Purchase Date,Quantity,Cost/Share,Cost Basis,Current Price,Market Value,Unrealized P&L,Unrealized P&L %";
const EQUITIES = ["ABBV", "MSFT", "BRK-B", "KO"];
const OPTIONS = ["AEM   260220C00280000", "C     260220P00080000"];
const CUSIP = "46438R105";

function buildExport(lotsPerSymbol: number): string {
  const rows: string[] = [HEADER];
  const symbols = [...EQUITIES, ...OPTIONS, CUSIP];
  for (const account of ["acct-a", "acct-b"]) {
    for (const symbol of symbols) {
      for (let lot = 0; lot < lotsPerSymbol; lot += 1) {
        rows.push(`${account},${symbol},Description,2026-03-${String(lot + 1).padStart(2, "0")},2,10.00,20.00,10.00,20.00,0.00,0.00`);
      }
    }
  }
  return rows.join("\n");
}

describe("lot-level holdings export through the import path", () => {
  const text = buildExport(25); // 2 accounts x 7 symbols x 25 lots = 350 rows

  it("passes the client size and row guards", () => {
    expect(getCsvFileSizeError(Buffer.byteLength(text))).toBeNull();
    const parsed = parseTickerCsvChecked(text);
    expect(parsed.error).toBeNull();
    expect(parsed.tickers).toHaveLength(350);
    expect(getCsvRowCountError(parsed.tickers.length)).toBeNull();
  });

  it("drops option contracts and CUSIPs client-side so the server never sees an overlong entry", () => {
    const { tickers } = parseTickerCsvChecked(text);
    const preview = prepareCsvSymbolPreview(tickers);
    expect(new Set(preview.tickers)).toEqual(new Set(EQUITIES));
    expect(preview.unsupportedUnique).toBe(OPTIONS.length + 1);
    expect(preview.unsupportedRows).toBe(2 * 25 * (OPTIONS.length + 1));
    // The raw column would be rejected wholesale by the server (400 invalid_ticker_entry).
    expect(() => parseImportBody({ tickers, dryRun: true })).toThrow();
    expect(OPTIONS.every((o) => o.length > MAX_RAW_TICKER_LENGTH)).toBe(true);
  });

  it("sends a body the server accepts and keeps every equity", () => {
    const { tickers } = parseTickerCsvChecked(text);
    const preview = prepareCsvSymbolPreview(tickers);
    expect(() => parseImportBody({ tickers: preview.tickers, dryRun: true })).not.toThrow();
    expect(classifyFormat(preview.tickers).candidates.sort()).toEqual([...EQUITIES].sort());
  });
});
