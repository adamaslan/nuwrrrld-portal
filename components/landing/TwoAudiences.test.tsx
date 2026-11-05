import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import TwoAudiences from "./TwoAudiences";

describe("TwoAudiences", () => {
  it("renders both audience cards with their copy", () => {
    render(
      <TwoAudiences
        title="Same product, two ways."
        beginner={{ heading: "Plain English", paragraphs: ["First para.", "Second para."] }}
        trader={{ heading: "Depth", paragraphs: ["Trader para."] }}
      />
    );
    expect(screen.getByRole("heading", { name: "New to markets?" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Trade actively?" })).toBeTruthy();
    expect(screen.getByText("Plain English")).toBeTruthy();
    expect(screen.getByText("Depth")).toBeTruthy();
    expect(screen.getByText("First para.")).toBeTruthy();
    expect(screen.getByText("Trader para.")).toBeTruthy();
  });
});
