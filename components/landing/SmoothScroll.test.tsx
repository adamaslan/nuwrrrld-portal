import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { SmoothScroll } from "./SmoothScroll";
import { setReducedMotion } from "@/test/reducedMotion";

describe("SmoothScroll", () => {
  afterEach(() => {
    setReducedMotion(false);
    vi.restoreAllMocks();
  });

  it("renders nothing", () => {
    setReducedMotion(false);
    const { container } = render(<SmoothScroll />);
    expect(container).toBeEmptyDOMElement();
  });

  it("under prefers-reduced-motion, never starts the rAF loop", () => {
    setReducedMotion(true);
    const rafSpy = vi.spyOn(window, "requestAnimationFrame");
    render(<SmoothScroll />);
    expect(rafSpy).not.toHaveBeenCalled();
  });

  it("with motion enabled, starts an rAF loop and cancels it on unmount", () => {
    setReducedMotion(false);
    const rafSpy = vi.spyOn(window, "requestAnimationFrame");
    const cancelSpy = vi.spyOn(window, "cancelAnimationFrame");

    const { unmount } = render(<SmoothScroll />);
    expect(rafSpy).toHaveBeenCalled();

    unmount();
    expect(cancelSpy).toHaveBeenCalled();
  });
});
