import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  setupIntersectionMocking,
  mockAllIsIntersecting,
  resetIntersectionMocking,
  destroyIntersectionMocking,
} from "react-intersection-observer/test-utils";
import { Reveal } from "./Reveal";
import { setReducedMotion } from "@/test/reducedMotion";

describe("Reveal", () => {
  beforeEach(() => {
    setupIntersectionMocking(vi.fn);
  });

  afterEach(() => {
    resetIntersectionMocking();
    destroyIntersectionMocking();
    setReducedMotion(false);
  });

  it("under prefers-reduced-motion, renders a plain static element (no motion wrapper)", () => {
    setReducedMotion(true);
    render(<Reveal as="article" aria-label="card">Hello</Reveal>);
    const el = screen.getByLabelText("card");
    expect(el.tagName).toBe("ARTICLE");
    expect(el).toHaveTextContent("Hello");
  });

  it("renders the 'as' element type when motion is enabled too", () => {
    setReducedMotion(false);
    render(<Reveal as="article" aria-label="card">Hello</Reveal>);
    expect(screen.getByLabelText("card").tagName).toBe("ARTICLE");
  });

  it("passes through role and aria-label to the rendered element", () => {
    setReducedMotion(true);
    render(<Reveal role="listitem" aria-label="entry">content</Reveal>);
    expect(screen.getByRole("listitem", { name: "entry" })).toBeInTheDocument();
  });
});
