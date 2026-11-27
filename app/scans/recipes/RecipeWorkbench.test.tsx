import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import RecipeWorkbench from "@/lib/shared/scan-recipes/RecipeWorkbench";

afterEach(cleanup);

describe("Scan workbench evaluated-input boundary", () => {
  it("removes a prior successful result when JSON is edited, then evaluates only on Run", () => {
    render(<RecipeWorkbench />);
    fireEvent.click(screen.getByRole("button", { name: "Load invented demo input" }));
    fireEvent.click(screen.getByRole("button", { name: "Run selected recipe or method" }));
    const first = JSON.parse(screen.getByTestId("recipe-output").textContent!);
    expect(first.status).toBe("available");
    expect(screen.getByTestId("synthetic-label")).toBeInTheDocument();
    const input = screen.getByLabelText("Input JSON, stays in this browser");
    fireEvent.change(input, { target: { value: "{" } });
    expect(screen.queryByTestId("recipe-output")).not.toBeInTheDocument();
    expect(screen.queryByTestId("synthetic-label")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Run selected recipe or method" }));
    expect(JSON.parse(screen.getByTestId("recipe-output").textContent!).status).toBe("missing");
    fireEvent.change(input, { target: { value: "{}" } });
    expect(screen.queryByTestId("recipe-output")).not.toBeInTheDocument();
  });
});
