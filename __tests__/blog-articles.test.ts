import { describe, expect, it } from "vitest";
import { BLOG_ARTICLES, getBlogArticle } from "@/lib/blog/articles";

describe("blog article data", () => {
  it("has exactly 10 articles", () => {
    expect(BLOG_ARTICLES).toHaveLength(10);
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
