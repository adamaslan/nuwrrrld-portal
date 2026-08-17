import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  setupIntersectionMocking,
  mockAllIsIntersecting,
  resetIntersectionMocking,
  destroyIntersectionMocking,
} from "react-intersection-observer/test-utils";
import { StatCounter } from "./StatCounter";
import { setReducedMotion } from "@/test/reducedMotion";

describe("StatCounter", () => {
  beforeEach(() => {
    setupIntersectionMocking(vi.fn);
  });

  afterEach(() => {
    resetIntersectionMocking();
    destroyIntersectionMocking();
    setReducedMotion(false);
    vi.restoreAllMocks();
  });

  it("under prefers-reduced-motion, renders the final value immediately with no animation", () => {
    setReducedMotion(true);
    render(<StatCounter value={1200} prefix="+" suffix="%" />);
    expect(screen.getByText("+1200%")).toBeInTheDocument();
  });

  it("starts at 0 before the element scrolls into view", () => {
    setReducedMotion(false);
    render(<StatCounter value={500} />);
    expect(screen.getByText("0")).toBeInTheDocument();
  });

  it("counts up to the final value once in view", async () => {
    setReducedMotion(false);
    render(<StatCounter value={100} durationMs={50} />);
    mockAllIsIntersecting(true);

    await vi.waitFor(() => expect(screen.getByText("100")).toBeInTheDocument(), { timeout: 2000 });
  });

  it("only triggers once (triggerOnce) — re-leaving view doesn't reset it to 0", async () => {
    setReducedMotion(false);
    render(<StatCounter value={42} durationMs={50} />);
    mockAllIsIntersecting(true);
    await vi.waitFor(() => expect(screen.getByText("42")).toBeInTheDocument(), { timeout: 2000 });

    mockAllIsIntersecting(false);
    expect(screen.getByText("42")).toBeInTheDocument();
  });
});
