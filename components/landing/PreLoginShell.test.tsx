import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PreLoginNav, PreLoginFooter } from "./PreLoginShell";

vi.mock("@/components/CookiePreferencesLink", () => ({
  default: () => <a href="#cookies">Cookie preferences</a>,
}));

describe("PreLoginNav", () => {
  it("links every pre-login destination with one CTA model", () => {
    render(<PreLoginNav />);
    expect(screen.getByRole("link", { name: "Signals" })).toHaveAttribute("href", "/signals");
    expect(screen.getByRole("link", { name: "Portfolio" })).toHaveAttribute("href", "/portfolio-intelligence");
    expect(screen.getByRole("link", { name: "Nu AI" })).toHaveAttribute("href", "/ai-assistant");
    expect(screen.getByRole("link", { name: "Pricing" })).toHaveAttribute("href", "/pricing");
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/sign-in");
    // primary CTA is always the free account, never the paid trial
    expect(screen.getByRole("link", { name: "Start free →" })).toHaveAttribute("href", "/sign-up");
  });
});

describe("PreLoginFooter", () => {
  it("carries the legal links", () => {
    render(<PreLoginFooter />);
    expect(screen.getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "/privacy-policy");
    expect(screen.getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms-of-service");
  });
});
