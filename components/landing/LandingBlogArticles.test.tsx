import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LandingBlogArticles } from "@/components/landing/LandingBlogArticles";
import { BLOG_ARTICLES, LANDING_BLOG_ARTICLES, getBlogArticle } from "@/lib/blog/articles";
import { readFileSync } from "node:fs";
describe("six-article public rollout", () => {
 it("selects exactly two method notes, each in the six-article release", () => {
  expect(BLOG_ARTICLES).toHaveLength(6);expect(LANDING_BLOG_ARTICLES).toHaveLength(2);
  for (const a of LANDING_BLOG_ARTICLES) {expect(a.kind).toBe("method");expect(getBlogArticle(a.slug)).toBe(a);}
  expect(getBlogArticle("hit-rate-vs-chance")).toBeUndefined();
 });
 it("renders two usable article cards without auth or model effects", () => {
  const html=renderToStaticMarkup(<LandingBlogArticles />);
  expect(html.match(/<article/g)).toHaveLength(2);
  for (const a of LANDING_BLOG_ARTICLES) expect(html).toContain(`/blog/${a.slug}`);
  expect(html).toContain('href="/blog"');expect(html).toContain("No new performance results");
 });
 it("wires the cards only into the existing anonymous home flow", () => {
  const page=readFileSync("app/page.tsx","utf8");expect(page).toContain('if (userId) redirect("/dashboard")');expect(page).toContain("<LandingBlogArticles />");
 });
});
