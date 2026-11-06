/**
 * Browser-side CSV → candidate ticker strings. Convenience only: the server
 * re-validates every value (lib/watchlist-import.ts), so nothing here is a
 * security boundary.
 */
export const MAX_CSV_FILE_BYTES = 64 * 1024;
const HEADER_NAMES = ["ticker", "symbol"];

/**
 * RFC 4180-style tokenizer: quoted fields may contain commas, CR/LF and
 * doubled quotes ("" → "). Rows end at LF or CRLF. Blank rows and rows whose
 * first cell starts with "#" are dropped. A quote left open at end of input is
 * reported, never silently folded into the last cell.
 */
function parseRows(text: string): { rows: string[][]; unterminatedQuote: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;

  const endRow = () => {
    row.push(cell);
    cell = "";
    const isBlank = row.every((c) => c.trim() === "");
    const isComment = row[0].trim().startsWith("#");
    if (!isBlank && !isComment) rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 2;
        continue;
      }
      if (ch === '"') inQuotes = false;
      else cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && cell.trim() === "") {
      inQuotes = true;
      cell = "";
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" && text[i + 1] === "\n") {
      endRow();
      i += 1;
    } else if (ch === "\n" || ch === "\r") {
      endRow();
    } else {
      cell += ch;
    }
    i += 1;
  }
  const unterminatedQuote = inQuotes;
  if (cell !== "" || row.length > 0) endRow();
  return { rows, unterminatedQuote };
}

export interface TickerCsvResult {
  tickers: string[];
  /** Set when the file is malformed; `tickers` is then empty so nothing partial is imported. */
  error: string | null;
}

export const UNTERMINATED_QUOTE_ERROR =
  "A quoted value is never closed (stray \" character). Fix the file and try again.";

export function parseTickerCsvChecked(text: string): TickerCsvResult {
  const { rows, unterminatedQuote } = parseRows(text.replace(/^\uFEFF/, ""));
  if (unterminatedQuote) return { tickers: [], error: UNTERMINATED_QUOTE_ERROR };
  if (rows.length === 0) return { tickers: [], error: null };

  const headerCells = rows[0].map((c) => c.trim().toLowerCase());
  const col = headerCells.findIndex((c) => HEADER_NAMES.includes(c));
  const tickers =
    col >= 0
      ? rows.slice(1).map((r) => (r[col] ?? "").trim())
      : rows.map((r) => (r[0] ?? "").trim());
  return { tickers, error: null };
}

/** Tickers only; a malformed file yields [] (fail closed). Use parseTickerCsvChecked for the reason. */
export function parseTickerCsv(text: string): string[] {
  return parseTickerCsvChecked(text).tickers;
}
