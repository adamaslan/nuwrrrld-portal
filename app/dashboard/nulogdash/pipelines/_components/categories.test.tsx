import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  default: () => Promise.reject(new Error("DB query attempted in a component test")),
}));

import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { PaperAccountCard } from "./PaperTradingSection";
import { ScheduledWorkCard } from "./ScheduledWorkSection";
import type { PaperAccountStatus } from "@/lib/paper-status-db";
import type { CatalogEntry } from "@/lib/nulogdash-catalog";

function account(overrides: Partial<PaperAccountStatus> = {}): PaperAccountStatus {
  return {
    account: "t1",
    label: "Tech 1",
    seat: "T1",
    active: true,
    cash: 4200,
    startingCash: 10000,
    nav: 10850,
    totalReturn: 0.085,
    navDate: "2026-10-02",
    openPositions: 7,
    slots: [null, null, null, null],
    ...overrides,
  };
}

describe("PaperAccountCard", () => {
  it("says a slot never ran instead of leaving it blank", () => {
    render(<PaperAccountCard status={account()} />);
    expect(screen.getAllByText("Never run")).toHaveLength(4);
  });

  it("shows the latest NAV, return, and open-position count", () => {
    render(<PaperAccountCard status={account()} />);
    expect(screen.getByText(/NAV \$10,850/)).toBeInTheDocument();
    expect(screen.getByText(/\+8\.5%/)).toBeInTheDocument();
    expect(screen.getByText("7 open positions · cash $4,200")).toBeInTheDocument();
  });

  it("marks a degraded run as a warning and carries its skip reason", () => {
    render(
      <PaperAccountCard
        status={account({
          slots: [null, null, null, {
            slot: "settle", tradeDate: "2026-10-02", status: "degraded",
            skipReason: "quote_gap", ordersN: 0, modelCalls: 0, startedAt: "x",
          }],
        })}
      />,
    );
    expect(screen.getByText("degraded")).toHaveClass("nld-badge--blocked");
    expect(screen.getByText(/quote_gap/)).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    const { container } = render(<PaperAccountCard status={account()} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

const entry: CatalogEntry = {
  id: "ci.yml",
  label: "CI",
  source: ".github/workflows/ci.yml",
  trigger: "Push to main & pull requests",
  manual: false,
  subFeatures: [{ label: "test", detail: "Unit and component tests." }],
};

describe("ScheduledWorkCard", () => {
  it("says there is no run log for an entry that writes none", () => {
    render(<ScheduledWorkCard entry={entry} latestRun={null} />);
    expect(screen.getByText(/No run log row/)).toBeInTheDocument();
  });

  it("lists sub-features under a disclosure", () => {
    render(<ScheduledWorkCard entry={entry} latestRun={null} />);
    expect(screen.getByText("1 sub-features")).toBeInTheDocument();
    expect(screen.getByText("test")).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    const { container } = render(<ScheduledWorkCard entry={entry} latestRun={null} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
