import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PreLoginNav, PreLoginFooter } from "./PreLoginShell";

vi.mock("@/components/CookiePreferencesLink", () => ({
  default: () => <a href="#cookies">Cookie preferences</a>,
}));

vi.mock("next/navigation", () => ({ usePathname: () => "/signals" }));

describe("PreLoginNav", () => {
  it("links every pre-login destination with one CTA model", () => {
    render(<PreLoginNav />);
    // Links appear twice: desktop bar + mobile menu (<details>), intentionally identical.
    expect(screen.getAllByRole("link", { name: "Signals" })[0]).toHaveAttribute("href", "/signals");
    expect(screen.getAllByRole("link", { name: "Portfolio" })[0]).toHaveAttribute("href", "/portfolio-intelligence");
    expect(screen.getAllByRole("link", { name: "Nu AI" })[0]).toHaveAttribute("href", "/ai-assistant");
    expect(screen.getAllByRole("link", { name: "Pricing" })[0]).toHaveAttribute("href", "/pricing");
    expect(screen.getAllByRole("link", { name: "Sign in" })[0]).toHaveAttribute("href", "/sign-in");
    expect(screen.getAllByRole("link", { name: "Paper trading" })).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: "Track record" })).toHaveLength(2);
    for (const link of screen.getAllByRole("link", { name: "Signals" })) expect(link).toHaveAttribute("aria-current", "page");
    // primary CTA is always the free account, never the paid trial
    expect(screen.getAllByRole("link", { name: "Start free →" })).toHaveLength(2);
    for (const link of screen.getAllByRole("link", { name: "Start free →" })) expect(link).toHaveAttribute("href", "/sign-up");
    // mobile menu (<details>) duplicates every destination for small screens
    expect(screen.getAllByRole("link", { name: "Sign in" })).toHaveLength(2);
  });
});

describe("PreLoginFooter", () => {
  it("carries the legal links", () => {
    render(<PreLoginFooter />);
    expect(screen.getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "/privacy-policy");
    expect(screen.getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms-of-service");
  });
});

describe("public legal dialog contrast", () => {
  it("keeps the shared disclaimer action readable under monochrome public tokens", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync("app/landing.css", "utf8");
    expect(css).toMatch(/\.nwf-landing\s+\.disclaimer-btn\s*\{[^}]*color:\s*#fff\s*;[^}]*background:\s*#111\s*;[^}]*border-radius:\s*0\s*;/);
  });
});

describe("compact navigation with undecided cookie consent", () => {
  it("reserves narrow-phone consent space and scrolls all menu destinations", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync("app/landing.css", "utf8");
    expect(css).toMatch(/body:has\(\.consent-banner\)\s+\.nwf-landing\s+\.nav-menu-links\s*\{[^}]*max-height:[^;]+;[^}]*overflow-y:\s*auto/);
  });
});
