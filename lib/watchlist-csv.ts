/**
 * Browser-side CSV → candidate ticker strings. Convenience only: the server
 * re-validates every value (lib/watchlist-import.ts), so nothing here is a
 * security boundary.
 */
export const MAX_CSV_FILE_BYTES = 64 * 1024;
const HEADER_NAMES = ["ticker", "symbol"];

function firstCell(line: string): string {
  const cell = line.split(",")[0] ?? "";
  return cell.trim().replace(/^"|"$/g, "").trim();
}

export function parseTickerCsv(text: string): string[] {
  const lines = text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
  if (lines.length === 0) return [];

  const headerCells = lines[0].split(",").map((c) => c.trim().replace(/^"|"$/g, "").toLowerCase());
  const col = headerCells.findIndex((c) => HEADER_NAMES.includes(c));
  if (col >= 0) {
    return lines.slice(1).map((l) => (l.split(",")[col] ?? "").trim().replace(/^"|"$/g, "").trim());
  }
  return lines.map(firstCell);
}
