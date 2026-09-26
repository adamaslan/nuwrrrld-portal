import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FibLadder } from "./FibLadder";

const SPOT = 150;
const lv = (name: string, price: number) => ({
  name, price, distance_pct: ((price - SPOT) / SPOT) * 100, strength: "s", type: "retracement",
});

describe("FibLadder", () => {
  it("renders support and resistance around the price marker", () => {
    render(
      <FibLadder
        summary={{
          fib_levels: [lv("0.618", 138), lv("0.382", 162)],
          nearest_fib_support: 138,
          nearest_fib_resistance: 162,
          fib_confluence_zones: [{ price: 138.2, strength: "s", signal_count: 3, confluence_score: 4 }],
        }}
      />,
    );
    expect(screen.getByTestId("fib-ladder")).toBeTruthy();
    expect(screen.getByText(/NEAREST SUPPORT/)).toBeTruthy();
    expect(screen.getByTestId("fib-price").textContent).toContain("150.00");
    expect(screen.getByText(/Confluence zones/).textContent).toContain("138.20 (3 signals)");
  });

  it("renders nothing when there are no levels", () => {
    const { container } = render(<FibLadder summary={{}} />);
    expect(container.firstChild).toBeNull();
  });
});
