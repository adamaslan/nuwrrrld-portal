/**
 * Pure helpers for making /verdict/[ticker] discoverable without publishing
 * thin pages. A ticker page with no recorded verdict has nothing a searcher
 * can use, so it is kept out of the index and out of the sitemap; a page with
 * a recorded verdict is indexable and described by what was actually recorded.
 *
 * Import-safe (no DB, no Next): unit-tested directly.
 */
import { normalizeTicker } from "@/lib/shared/signal-policy";

/** Sitemaps allow 50,000 URLs; stay far below it so this one entry type can
 *  never crowd out the static pages. */
export const MAX_VERDICT_SITEMAP_ENTRIES = 2000;

const DIRECTION_LABEL: Record<string, string> = { bullish: "BUY", bearish: "SELL", neutral: "HOLD" };

export interface RecordedVerdict {
  direction: string | null;
  confidence: string | null;
  horizon: string | null;
}

export function directionLabel(direction: string | null | undefined): string | null {
  return direction ? (DIRECTION_LABEL[direction] ?? null) : null;
}

/** A page is indexable only when there is a recorded verdict to show. */
export function isVerdictIndexable(latest: RecordedVerdict | null | undefined): boolean {
  return Boolean(latest && directionLabel(latest.direction));
}

export function verdictTitle(ticker: string, latest: RecordedVerdict | null | undefined): string {
  const label = latest ? directionLabel(latest.direction) : null;
  return label ? `$${ticker} council verdict: ${label}` : `$${ticker} council verdict`;
}

export function verdictDescription(ticker: string, latest: RecordedVerdict | null | undefined): string {
  const label = latest ? directionLabel(latest.direction) : null;
  if (!latest || !label) {
    return `No council verdict has been recorded for $${ticker} yet.`;
  }
  const parts = [`The recorded council call on $${ticker} is ${label}`];
  if (latest.confidence) parts.push(`with ${latest.confidence} confidence`);
  if (latest.horizon) parts.push(`over a ${latest.horizon} horizon`);
  return `${parts.join(" ")}. Published as it was made, with the invalidation level when one was set. Research, not investment advice.`;
}

export interface SitemapEntry {
  url: string;
  lastModified: Date;
  changeFrequency: "daily";
  priority: number;
}

/**
 * Sitemap rows for tickers that have at least one recorded verdict. Input is
 * whatever the reader returned, so every value is re-validated: unknown or
 * malformed symbols are dropped, duplicates collapse, and the list is capped.
 */
export function buildVerdictSitemapEntries(
  tickers: readonly string[],
  siteUrl: string,
  now: Date,
): SitemapEntry[] {
  const seen = new Set<string>();
  const entries: SitemapEntry[] = [];
  for (const raw of tickers) {
    const ticker = normalizeTicker(raw);
    if (!ticker || seen.has(ticker)) continue;
    seen.add(ticker);
    entries.push({
      url: `${siteUrl}/verdict/${encodeURIComponent(ticker)}`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.6,
    });
    if (entries.length >= MAX_VERDICT_SITEMAP_ENTRIES) break;
  }
  return entries;
}
