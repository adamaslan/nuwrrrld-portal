import { vi } from "vitest";
import { hasReducedMotionListener, prefersReducedMotion } from "motion-dom";

/**
 * framer-motion's useReducedMotion() lazily initializes a module-level
 * singleton (motion-dom's `prefersReducedMotion`/`hasReducedMotionListener`)
 * on first use and never re-reads window.matchMedia after that. Without
 * resetting it between tests, whichever reduced-motion state ran first
 * "sticks" for the rest of the file. Call this in beforeEach, before
 * overriding window.matchMedia and rendering.
 */
export function setReducedMotion(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  hasReducedMotionListener.current = false;
  prefersReducedMotion.current = null;
}
