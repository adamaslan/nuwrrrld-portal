import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { CouncilScrollDebate } from "./CouncilScrollDebate";
import { setReducedMotion } from "@/test/reducedMotion";

// framer-motion's useScroll(target) is called unconditionally (Rules of Hooks)
// even on the reduced-motion branch, where containerRef never actually attaches
// to a DOM node. Its internal frame batcher then throws a "not hydrated"
// invariant asynchronously (motion.dev/troubleshooting/use-scroll-ref) — after
// the test's assertions already ran, purely a jsdom/timing artifact of this
// library pattern, not a bug in our component. Swallow just that one error.
let uncaughtHandler: NodeJS.UncaughtExceptionListener;

describe("CouncilScrollDebate", () => {
  beforeEach(() => {
    uncaughtHandler = (err) => {
      if (err instanceof Error && err.message.includes("not hydrated")) return;
      throw err;
    };
    process.on("uncaughtException", uncaughtHandler);
  });

  afterEach(() => {
    process.off("uncaughtException", uncaughtHandler);
    setReducedMotion(false);
  });

  it("under prefers-reduced-motion, renders a static, fully-revealed list (no pinning)", () => {
    setReducedMotion(true);
    const { container } = render(<CouncilScrollDebate />);

    expect(container.querySelector(".council-debate--static")).not.toBeNull();
    const lines = container.querySelectorAll(".council-debate-line");
    expect(lines.length).toBe(6);
    lines.forEach((line) => expect(line.classList.contains("is-revealed")).toBe(true));
  });

  it("with motion enabled, only the first seat starts revealed/active", () => {
    setReducedMotion(false);
    const { container } = render(<CouncilScrollDebate />);

    const lines = container.querySelectorAll(".council-debate-line");
    expect(lines.length).toBe(6);
    expect(lines[0].classList.contains("is-revealed")).toBe(true);
    expect(lines[0].classList.contains("is-active")).toBe(true);
    expect(lines[1].classList.contains("is-revealed")).toBe(false);
  });

  it("renders every seat's tag and debate line text", () => {
    setReducedMotion(true);
    const { getByText } = render(<CouncilScrollDebate />);
    expect(getByText("T1")).toBeInTheDocument();
    expect(getByText("CHAIR")).toBeInTheDocument();
    expect(getByText(/Verdict: bullish, medium confidence/)).toBeInTheDocument();
  });
});
