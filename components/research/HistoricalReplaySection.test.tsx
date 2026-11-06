import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { HistoricalReplaySection } from "./HistoricalReplaySection";
import type { HistoricalReplayVM, ReplayReadResult } from "@/lib/shared/historical-replay-view";

const view = (over: Partial<HistoricalReplayVM> = {}): HistoricalReplayVM => ({
  mode: "reconstructed",
  label: "Historical backtest reconstruction, not a live track record",
  format: "signals-pr51-unversioned-research",
  productionPriorEligible: false,
  decisionStart: "2025-11-06", observationCutoff: "2026-11-05", computedAt: "2026-11-06T05:00:00Z",
  seedHash: "a".repeat(64), engineHash: "b".repeat(64),
  requested: 3, complete: 1, partial: 0, missing: 1, errors: 0, unsupported: 1,
  mixedInputBasis: true, basisPolicy: "Bases are never pooled.",
  coverage: [{ ticker: "AAPL", status: "ok" }, { ticker: "BTC-USD", status: "missing_history" }, { ticker: "VTSAX", status: "unsupported_asset_type" }],
  bases: [
    { id: "basis-0", source: "alpaca-sip-daily", adjustment: "split" },
    { id: "basis-1", source: "alpaca-crypto-us", adjustment: "none (raw)" },
  ],
  priceBasis: { source: "FIXTURE", adjustment: "fixture", calendarPolicy: "fixture calendar" },
  horizons: [5],
  buckets: [
    { basis: "basis-0", category: "MACD", strength: "BULLISH", horizonBars: 5, hits: 20, misses: 9, flat: 1, pending: 5, resolved: 30, hitRate: 20 / 30 },
    { basis: "basis-1", category: "RSI", strength: "BEARISH", horizonBars: 5, hits: 3, misses: 2, flat: 0, pending: 1, resolved: 5, hitRate: null },
  ],
  councilHistory: "not_available", judgeHistory: "not_available",
  ...over,
});
const partial = (over: Partial<HistoricalReplayVM> = {}): ReplayReadResult => ({ status: "partial", view: view(over) });

describe("HistoricalReplaySection", () => {
  it("says nothing is loaded instead of guessing", () => {
    render(<HistoricalReplaySection result={{ status: "not_computed", view: null }} />);
    expect(screen.getByText(/no replay artifact has been loaded/i)).toBeInTheDocument();
  });
  it("shows validation failures as an alert and no data", () => {
    render(<HistoricalReplaySection result={{ status: "invalid_run", view: null, reason: "provenance hash mismatch" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/provenance hash mismatch/);
    expect(screen.queryByRole("table")).toBeNull();
  });
  it("labels the data as reconstructed research, never a live track record or prior", () => {
    render(<HistoricalReplaySection result={partial()} />);
    expect(screen.getByRole("note")).toHaveTextContent(/not a live track record/i);
    expect(screen.getByRole("note")).toHaveTextContent(/not a production prior/i);
    expect(screen.getByText(/council and judge history are not available/i)).toBeInTheDocument();
  });
  it("makes partial coverage and unsupported rows explicit", () => {
    render(<HistoricalReplaySection result={partial()} />);
    expect(screen.getByText(/1 of 3 symbols are calendar-complete/)).toBeInTheDocument();
    expect(screen.getByText("unsupported asset type: 1")).toBeInTheDocument();
    expect(screen.getByText("missing history: 1")).toBeInTheDocument();
  });
  it("lists the symbols behind the partial-coverage sentence in a disclosure, grouped by status", () => {
    render(<HistoricalReplaySection result={partial()} />);
    expect(screen.getByText(/The other 2 are listed by status in the disclosure under Coverage/)).toBeInTheDocument();
    const summary = screen.getByText("Show the 2 symbols that are not calendar-complete (ticker and status)");
    const box = summary.closest("details") as HTMLElement;
    expect(box).toHaveTextContent("missing history (1)");
    expect(box).toHaveTextContent("BTC-USD");
    expect(box).toHaveTextContent("unsupported asset type (1)");
    expect(box).toHaveTextContent("VTSAX");
    expect(box).not.toHaveTextContent("AAPL");
  });
  it("keeps each price basis in its own table and states they are never pooled", () => {
    render(<HistoricalReplaySection result={partial()} />);
    expect(screen.getAllByRole("table")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: /^basis-0\b/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^basis-1\b/ })).toBeInTheDocument();
    expect(screen.getByText(/never pooled across bases/i)).toBeInTheDocument();
  });
  it("shows each declared feed and adjustment per basis, not opaque ids", () => {
    render(<HistoricalReplaySection result={partial()} />);
    const list = screen.getByRole("list", { name: "Declared price bases" });
    expect(list).toHaveTextContent("basis-0: alpaca-sip-daily; adjustment: split");
    expect(list).toHaveTextContent("basis-1: alpaca-crypto-us; adjustment: none (raw)");
    expect(screen.getByRole("heading", { name: /basis-1.*alpaca-crypto-us.*none \(raw\)/ })).toBeInTheDocument();
  });
  it("shows a hit rate only when the reader provides one", () => {
    render(<HistoricalReplaySection result={partial()} />);
    expect(screen.getByText("66.7%")).toBeInTheDocument();
    expect(screen.getByText("n<30, not shown")).toBeInTheDocument();
  });
  it("collapses long bucket lists: the 25 largest are visible, the rest sit behind a disclosure", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      basis: "basis-0", category: `CAT${String(i).padStart(2, "0")}`, strength: "BULLISH", horizonBars: 5,
      hits: 1, misses: 1, flat: 0, pending: 0, resolved: 100 - i, hitRate: null,
    }));
    render(<HistoricalReplaySection result={partial({ buckets: many })} />);
    expect(screen.getByText(/40 buckets, largest 25 by resolved count/)).toBeInTheDocument();
    const summary = screen.getByText("Show the other 15 buckets for basis-0");
    expect(summary.closest("details")).not.toBeNull();
    expect(screen.getAllByRole("table", { hidden: true })).toHaveLength(2);
    expect(screen.getByRole("rowheader", { name: "CAT00" })).toBeInTheDocument();
  });
  it("has no accessibility violations", async () => {
    const { container } = render(<HistoricalReplaySection result={partial()} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
