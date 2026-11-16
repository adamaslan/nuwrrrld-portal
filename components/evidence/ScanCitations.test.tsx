import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ScanCitations } from "./ScanCitations";

describe("A3 ScanCitations", () => {
  it("links a known card and never links an unknown one", () => {
    const { container } = render(
      <ScanCitations
        text="Compare se1.trend.golden_cross_recency with se1.trend.not_a_real_card."
        cards={[{ id: "se1.trend.golden_cross_recency", version: "1.0.0" }]}
      />,
    );
    const links = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links).toEqual(["/scans/se1.trend.golden_cross_recency"]);
    expect(screen.getByText("(unknown scan)", { exact: false }).textContent).toContain("se1.trend.not_a_real_card");
  });
});
