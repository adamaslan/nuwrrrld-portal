import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ExplainScan } from "./ExplainScan";

afterEach(() => vi.unstubAllGlobals());

describe("X26-04 ExplainScan", () => {
  it("shows a model answer with its checked label and posts only the card id", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ answer: "No run yet.", source: "model" })));
    vi.stubGlobal("fetch", fetchMock);
    render(<ExplainScan cardId="se1.trend.golden_cross_recency" />);
    fireEvent.click(screen.getByRole("button", { name: "Explain this result" }));
    expect(await screen.findByText(/No run yet\./)).toBeTruthy();
    expect(screen.getByText(/checked against the card facts/)).toBeTruthy();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ card: "se1.trend.golden_cross_recency" });
  });

  it("shows the standard text when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    render(<ExplainScan cardId="se1.trend.golden_cross_recency" />);
    fireEvent.click(screen.getByRole("button", { name: "Explain this result" }));
    await waitFor(() => expect(screen.getByText(/unavailable right now/)).toBeTruthy());
    expect(screen.getByText(/standard text/)).toBeTruthy();
  });
});
