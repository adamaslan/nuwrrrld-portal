import { afterEach, describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ParallaxStage, ParallaxLayer } from "./ParallaxStage";
import { setReducedMotion } from "@/test/reducedMotion";

describe("ParallaxStage / ParallaxLayer", () => {
  afterEach(() => {
    setReducedMotion(false);
  });

  it("renders children inside the stage and each layer", () => {
    setReducedMotion(false);
    render(
      <ParallaxStage aria-label="stage">
        <ParallaxLayer depth={1}>main phone</ParallaxLayer>
        <ParallaxLayer depth={0.5}>side phone</ParallaxLayer>
      </ParallaxStage>,
    );
    expect(screen.getByText("main phone")).toBeInTheDocument();
    expect(screen.getByText("side phone")).toBeInTheDocument();
  });

  it("under prefers-reduced-motion, layers render as plain (non-motion) divs", () => {
    setReducedMotion(true);
    const { container } = render(
      <ParallaxStage aria-label="stage">
        <ParallaxLayer depth={1} className="phone-layer">
          static phone
        </ParallaxLayer>
      </ParallaxStage>,
    );
    const layer = container.querySelector(".phone-layer");
    expect(layer).not.toBeNull();
    expect(layer?.tagName).toBe("DIV");
    // no inline transform applied in the reduced-motion / no-context branch
    expect((layer as HTMLElement).style.transform).toBe("");
  });

  it("a ParallaxLayer used outside a ParallaxStage still renders (falls back gracefully)", () => {
    setReducedMotion(false);
    render(<ParallaxLayer depth={1}>orphan layer</ParallaxLayer>);
    expect(screen.getByText("orphan layer")).toBeInTheDocument();
  });

  it("mouse movement over the stage does not throw", () => {
    setReducedMotion(false);
    const { container } = render(
      <ParallaxStage aria-label="stage">
        <ParallaxLayer depth={1}>main phone</ParallaxLayer>
      </ParallaxStage>,
    );
    const stage = container.firstChild as HTMLElement;
    expect(() => {
      fireEvent.mouseMove(stage, { clientX: 10, clientY: 10 });
      fireEvent.mouseLeave(stage);
    }).not.toThrow();
  });
});
