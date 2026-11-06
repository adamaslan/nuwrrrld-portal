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
 * first cell starts with "#" are dropped.
 */
function parseRows(text: string): string[][] {
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
    } else if (ch === "\n") {
      endRow();
    } else {
      cell += ch;
    }
    i += 1;
  }
  if (cell !== "" || row.length > 0) endRow();
  return rows;
}

export function parseTickerCsv(text: string): string[] {
  const rows = parseRows(text.replace(/^﻿/, ""));
  if (rows.length === 0) return [];

  const headerCells = rows[0].map((c) => c.trim().toLowerCase());
  const col = headerCells.findIndex((c) => HEADER_NAMES.includes(c));
  if (col >= 0) {
    return rows.slice(1).map((r) => (r[col] ?? "").trim());
  }
  return rows.map((r) => (r[0] ?? "").trim());
}
