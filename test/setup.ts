import "@testing-library/jest-dom/vitest";
import { afterEach, expect, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { toHaveNoViolations } from "jest-axe";

declare global {
  interface Window {
    __rafPatchedForTests?: boolean;
  }
}

// jest-axe ships a Jest-style matcher; register it on vitest's expect so
// component suites can assert `expect(await axe(container)).toHaveNoViolations()`.
expect.extend(toHaveNoViolations);

afterEach(() => {
  cleanup();
});

// jsdom has no matchMedia — framer-motion's useReducedMotion() and any
// `prefers-reduced-motion` check would throw without this. Defaults to
// "no preference" (matches: false); tests opt into reduced-motion by
// overriding matchMedia per-test.
if (typeof window.matchMedia === "undefined") {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

// jsdom has no IntersectionObserver — react-intersection-observer (StatCounter,
// Reveal) and any manual observer usage need at least a stub to mount.
class MockIntersectionObserver implements IntersectionObserver {
  readonly root: Element | Document | null = null;
  readonly rootMargin: string = "";
  readonly thresholds: ReadonlyArray<number> = [];
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  takeRecords = vi.fn(() => []);
}
if (typeof window.IntersectionObserver === "undefined") {
  window.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;
}

// jsdom doesn't implement scrollIntoView (used by NuAIChat's auto-scroll-to-bottom).
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn();
}

// jsdom has no ResizeObserver — Lenis (SmoothScroll) measures dimensions with one.
class MockResizeObserver implements ResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
if (typeof window.ResizeObserver === "undefined") {
  window.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
}

// jsdom's requestAnimationFrame callback timestamp is unrelated to
// performance.now(), so rAF-driven progress math (StatCounter, any
// (now - start) / duration easing) sees garbage deltas. Tie it to real time.
if (typeof window.requestAnimationFrame === "undefined" || !window.__rafPatchedForTests) {
  window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    return setTimeout(() => callback(performance.now()), 16) as unknown as number;
  }) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = ((handle: number) => clearTimeout(handle)) as typeof window.cancelAnimationFrame;
  window.__rafPatchedForTests = true;
}
