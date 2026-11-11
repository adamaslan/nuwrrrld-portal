import { describe, expect, it } from "vitest";
import { BLOG_ARTICLES, getBlogArticle } from "@/lib/blog/articles";

describe("blog article data", () => {
  it("has 14 articles, preserving the ten original backtests", () => {
    expect(BLOG_ARTICLES).toHaveLength(14);
  });

  it("separates four sourced method notes from historical backtest evidence", () => {
    const methods = BLOG_ARTICLES.filter(a => a.kind === "method");
    expect(methods).toHaveLength(4);
    for (const a of methods) {
      expect(a.date).toBe("2026-11-11");
      expect(a.sources?.length).toBeGreaterThan(0);
      for (const source of a.sources ?? []) expect(source.href).toMatch(/^https:\/\//);
      expect(a.blocks.some(b => b.kind === "stats" || b.kind === "table")).toBe(false);
    }
    expect(BLOG_ARTICLES.filter(a => a.kind !== "method")).toHaveLength(10);
  });

  it("has unique, URL-safe slugs", () => {
    const slugs = BLOG_ARTICLES.map((a) => a.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) {
      expect(slug).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("every article has a title, description, ISO date, feature tag, and content", () => {
    for (const a of BLOG_ARTICLES) {
      expect(a.title.length).toBeGreaterThan(0);
      expect(a.description.length).toBeGreaterThan(0);
      expect(a.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(a.feature.length).toBeGreaterThan(0);
      expect(a.blocks.length).toBeGreaterThan(3);
    }
  });

  it("every article carries the historical-results disclaimer", () => {
    for (const a of BLOG_ARTICLES) {
      const text = a.blocks
        .flatMap((b) => (b.kind === "list" ? b.items : b.kind === "p" ? [b.text] : []))
        .join(" ");
      expect(text).toContain("Past results do not predict future results");
    }
  });

  it("getBlogArticle round-trips every article and rejects unknown slugs", () => {
    for (const a of BLOG_ARTICLES) {
      expect(getBlogArticle(a.slug)).toBe(a);
    }
    expect(getBlogArticle("not-a-real-article")).toBeUndefined();
  });
});
