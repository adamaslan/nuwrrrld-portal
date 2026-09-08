import { describe, expect, it, vi } from "vitest";

// These pages are server components that query pipeline_run_log at request
// time; the presentational pieces under test don't. Mocking @/lib/db keeps the
// module graph importable without a DATABASE_URL and fails loudly if a
// component ever starts querying. Same pattern as __tests__/pipeline-run-log.test.ts.
vi.mock("@/lib/db", () => ({
  default: () => Promise.reject(new Error("DB query attempted in a component test")),
}));

import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { RunModeBadge, RunRow } from "./page";
import { OutcomeBadge, ItemRow } from "./[id]/page";
import type { PipelineRunRow } from "@/lib/pipeline-run-log-db";

function run(overrides: Partial<PipelineRunRow> = {}): PipelineRunRow {
  return {
    id: "89bfec09-1fab-484c-812c-90c80a83e4cf",
    pipeline: "precompute-ai",
    runAt: "2026-09-08T13:45:54.024Z",
    dryRun: true,
    session: null,
    itemsTotal: 2,
    itemsAi: 0,
    models: {},
    items: [
      { subject: "AAPL", model: null, outcome: "skip" },
      { subject: "MSFT", model: null, outcome: "skip" },
    ],
    summary: { selection: "watchlist" },
    ...overrides,
  };
}

function table(ui: React.ReactElement) {
  return render(<table><tbody>{ui}</tbody></table>);
}

describe("RunModeBadge", () => {
  // The dry-run/live distinction is the only thing on this page that says
  // whether a run spent money and wrote rows — it must never be ambiguous.
  it("distinguishes a dry run from a live run", () => {
    const { unmount } = render(<RunModeBadge dryRun />);
    expect(screen.getByText("Dry run")).toBeInTheDocument();
    unmount();
    render(<RunModeBadge dryRun={false} />);
    expect(screen.getByText("Live")).toBeInTheDocument();
  });
});

describe("RunRow", () => {
  it("links the run to its detail page by id", () => {
    table(<RunRow run={run()} />);
    expect(screen.getByRole("link", { name: /precompute ai/i })).toHaveAttribute(
      "href",
      "/dashboard/nulogdash/pipelines/89bfec09-1fab-484c-812c-90c80a83e4cf",
    );
  });

  it("summarizes outcomes from the run's items", () => {
    table(<RunRow run={run({ items: [
      { subject: "A", model: "m", outcome: "ok" },
      { subject: "B", model: "m", outcome: "fail" },
      { subject: "C", model: null, outcome: "skip" },
    ] })} />);
    expect(screen.getByText(/1 ok · 0 empty · 1 fail · 1 skip/)).toBeInTheDocument();
  });

  it("falls back to the raw pipeline name for an unlabelled pipeline", () => {
    table(<RunRow run={run({ pipeline: "followed-tickers" })} />);
    expect(screen.getByRole("link", { name: /followed tickers/i })).toBeInTheDocument();
  });
});

describe("ItemRow", () => {
  it("renders every field a debug pass needs, with placeholders for absent ones", () => {
    table(<ItemRow item={{ subject: "AAPL", seat: "bull", model: "x/y", outcome: "ok", latencyMs: 812, fallback: true }} />);
    expect(screen.getByText("AAPL")).toBeInTheDocument();
    expect(screen.getByText("bull")).toBeInTheDocument();
    expect(screen.getByText("x/y")).toBeInTheDocument();
    expect(screen.getByText("812ms")).toBeInTheDocument();
    expect(screen.getByText("yes")).toBeInTheDocument();
  });

  it("shows an em dash rather than 'undefined' when a model never served", () => {
    const { container } = table(<ItemRow item={{ subject: "AAPL", model: null, outcome: "skip" }} />);
    expect(container.textContent).not.toContain("undefined");
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(3);
  });
});

describe("OutcomeBadge", () => {
  it.each(["ok", "empty", "fail", "skip"] as const)("renders the %s outcome", (outcome) => {
    render(<OutcomeBadge outcome={outcome} />);
    expect(screen.getByText(outcome)).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    const { container } = render(<OutcomeBadge outcome="fail" />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
