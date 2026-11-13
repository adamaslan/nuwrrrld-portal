import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import article from "@/lib/research/nvidia-scenarios.json";
const read = (p: string) => readFileSync(p,"utf8");
describe("dated static NVIDIA research",()=>{
 it("retains six requested forward horizons and all conditional paths",()=>{
  expect(article.scenarios.map(s=>s.horizon)).toEqual(["1 week","1 month","3 months","6 months","9 months","12 months"]);
  for(const s of article.scenarios)for(const k of ["up","middle","down","check"] as const)expect(s[k].length).toBeGreaterThan(80);
 });
 it("retains frozen scan provenance and unavailable coverage",()=>{
  const text=article.method.join(" ");expect(text).toContain("3,129 occurrences");expect(text).toContain("252 evaluation bars");expect(text).toContain("100 additional");expect(text).toContain("were not executed");expect(text).toContain("not a live November 13 quote");
 });
 it("features a signed-out route without depending on the separate blog PR",()=>{
  const home=read("app/page.tsx");expect(home).toContain('id="nvidia-research"');expect(home).toContain('href="/research/nvidia-forward-scenarios"');expect(home).toContain("not predictions, probabilities");expect(home).not.toContain("LandingBlogArticles");
 });
 it("keeps the route static and metadata explicitly dated",()=>{
  const page=read("app/research/nvidia-forward-scenarios/page.tsx");expect(page).toContain("Research dated November 13, 2026");expect(page).toContain("PreLoginNav");expect(page).toContain("PreLoginFooter");expect(page).not.toMatch(/await auth|redirect\(|getStoredSignals|fetch\(|DATABASE_URL/);
 });
 it("keeps sources and conditional wording instead of invented forecast confidence",()=>{
  expect(article.chart.length).toBe(126);expect(article.chart.at(-1)).toEqual({date:"2026-11-12",close:166.19,tenkan:179.39,kijun:192.935,spanA:229.7,spanB:216.69});expect(article.sources.length).toBe(8);for(const s of article.sources)expect(s[2]).toMatch(/^https:\/\//);expect(article.closing.join(" ")).toContain("No price targets");
 });
});
