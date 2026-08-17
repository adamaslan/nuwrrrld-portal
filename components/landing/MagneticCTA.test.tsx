import { afterEach, describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MagneticCTA } from "./MagneticCTA";
import { setReducedMotion } from "@/test/reducedMotion";

describe("MagneticCTA", () => {
  afterEach(() => {
    setReducedMotion(false);
  });

  it("renders as a plain anchor pointing at href", () => {
    setReducedMotion(false);
    render(<MagneticCTA href="/sign-up">Get started</MagneticCTA>);
    const link = screen.getByRole("link", { name: "Get started" });
    expect(link).toHaveAttribute("href", "/sign-up");
  });

  it("under prefers-reduced-motion, mouse movement does not apply a transform style", () => {
    setReducedMotion(true);
    render(<MagneticCTA href="/sign-up">Get started</MagneticCTA>);
    const link = screen.getByRole("link", { name: "Get started" });

    fireEvent.mouseMove(link, { clientX: 40, clientY: 40 });

    // reduceMotion branch passes `style={undefined}` — framer-motion renders
    // no inline transform in that case.
    expect(link.style.transform).toBe("");
  });

  it("does not throw when the mouse leaves without ever moving over it", () => {
    setReducedMotion(false);
    render(<MagneticCTA href="/sign-up">Get started</MagneticCTA>);
    const link = screen.getByRole("link", { name: "Get started" });
    expect(() => fireEvent.mouseLeave(link)).not.toThrow();
  });
});
