import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import RecordedOutcomes from "./RecordedOutcomes";

describe("RecordedOutcomes read states", () => {
  it("labels only a successful empty read as building", () => {
    render(<RecordedOutcomes record={null} status="empty" />);
    expect(screen.getByText(/latest successful read/)).toBeInTheDocument();
  });
  it("labels unavailable data without implying zero scored outcomes", () => {
    render(<RecordedOutcomes record={null} status="unavailable" />);
    expect(screen.getByText(/temporarily unavailable/)).toBeInTheDocument();
    expect(screen.queryByText(/still building/)).not.toBeInTheDocument();
  });
});
