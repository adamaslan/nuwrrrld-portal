import type { MetadataRoute } from "next";
import { buildVerdictSitemapEntries, MAX_VERDICT_SITEMAP_ENTRIES } from "@/lib/verdict-seo";

const SITE_URL = "https://financial.nuwrrrld.com";

// Verdict URLs come from the database; an hour of staleness is fine.
export const revalidate = 3600;

/**
 * Tickers with a recorded verdict. The DB module is imported lazily because it
 * throws at import time when DATABASE_URL is unset, and this file is
 * prerendered: a build without a database must still produce the static pages.
 */
async function verdictTickers(): Promise<string[]> {
  try {
    const { tickersWithVerdicts } = await import("@/lib/council-db");
    return await tickersWithVerdicts(MAX_VERDICT_SITEMAP_ENTRIES);
  } catch {
    return [];
  }
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const staticPages: MetadataRoute.Sitemap = [
    { url: SITE_URL, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE_URL}/pricing`, lastModified: now, changeFrequency: "monthly", priority: 0.9 },
    { url: `${SITE_URL}/signals`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${SITE_URL}/ai-assistant`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${SITE_URL}/portfolio-intelligence`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${SITE_URL}/scans`, lastModified: now, changeFrequency: "monthly", priority: 0.5 },
    { url: `${SITE_URL}/terms-of-service`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${SITE_URL}/privacy-policy`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
  ];
  return [...staticPages, ...buildVerdictSitemapEntries(await verdictTickers(), SITE_URL, now)];
}
