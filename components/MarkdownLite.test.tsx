import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MarkdownLite } from "./MarkdownLite";

describe("MarkdownLite", () => {
  it("renders bold, italic, and inline code instead of raw markers", () => {
    const { container } = render(
      <MarkdownLite text={"**RSI** is *oversold* at `28.4`"} />,
    );
    expect(container.querySelector("strong")).toHaveTextContent("RSI");
    expect(container.querySelector("em")).toHaveTextContent("oversold");
    expect(container.querySelector("code")).toHaveTextContent("28.4");
    expect(container.textContent).not.toContain("**");
  });

  it("renders bullet lists as lists", () => {
    const { container } = render(
      <MarkdownLite text={"- first\n- second\n- **third**"} />,
    );
    const items = container.querySelectorAll("ul li");
    expect(items).toHaveLength(3);
    expect(items[2].querySelector("strong")).toHaveTextContent("third");
  });

  it("renders numbered lists as ordered lists", () => {
    const { container } = render(<MarkdownLite text={"1. one\n2. two"} />);
    expect(container.querySelectorAll("ol li")).toHaveLength(2);
  });

  it("splits paragraphs on blank lines", () => {
    const { container } = render(<MarkdownLite text={"para one\n\npara two"} />);
    expect(container.querySelectorAll("p")).toHaveLength(2);
  });

  it("leaves unmatched markers as literal text", () => {
    render(<MarkdownLite text={"a * b and 2*3"} />);
    expect(screen.getByText(/a \* b and 2\*3/)).toBeInTheDocument();
  });
});
