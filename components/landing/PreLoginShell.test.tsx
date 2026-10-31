import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PreLoginNav, PreLoginFooter } from "./PreLoginShell";

vi.mock("@/components/CookiePreferencesLink", () => ({
  default: () => <a href="#cookies">Cookie preferences</a>,
}));

describe("PreLoginNav", () => {
  it("links every pre-login destination with one CTA model", () => {
    render(<PreLoginNav />);
    // Links appear twice: desktop bar + mobile menu (<details>), intentionally identical.
    expect(screen.getAllByRole("link", { name: "Signals" })[0]).toHaveAttribute("href", "/signals");
    expect(screen.getAllByRole("link", { name: "Portfolio" })[0]).toHaveAttribute("href", "/portfolio-intelligence");
    expect(screen.getAllByRole("link", { name: "Nu AI" })[0]).toHaveAttribute("href", "/ai-assistant");
    expect(screen.getAllByRole("link", { name: "Pricing" })[0]).toHaveAttribute("href", "/pricing");
    expect(screen.getAllByRole("link", { name: "Sign in" })[0]).toHaveAttribute("href", "/sign-in");
    // primary CTA is always the free account, never the paid trial
    expect(screen.getByRole("link", { name: "Start free →" })).toHaveAttribute("href", "/sign-up");
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
