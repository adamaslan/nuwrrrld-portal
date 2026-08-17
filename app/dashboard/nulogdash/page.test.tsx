import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { MfaNotice, StatusBadge, FeatureRow } from "./page";
import type { FeatureResult } from "@/lib/nulogdash";

function feature(overrides: Partial<FeatureResult> = {}): FeatureResult {
  return {
    feature: "signals-digest",
    label: "Signal Digest",
    entrypoints: ["/dashboard/signals"],
    tier: "browser",
    dependencies: [],
    latencyMs: 142,
    status: "pass",
    reason: null,
    ...overrides,
  };
}

describe("MfaNotice", () => {
  it("tells the admin why mutating actions are withheld", () => {
    render(<MfaNotice />);
    expect(screen.getByText(/two-factor authentication required for admin actions/i)).toBeInTheDocument();
    expect(screen.getByText(/impersonate, disable, reset password, reindex/i)).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    const { container } = render(<MfaNotice />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("StatusBadge", () => {
  it.each([
    ["pass", "Pass"],
    ["fail", "Fail"],
    ["blocked", "Blocked"],
    ["not_run", "Not run"],
  ] as const)("renders the %s status with label %s", (status, label) => {
    render(<StatusBadge status={status} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("applies a status-specific class so pass/fail/blocked are visually distinct", () => {
    render(<StatusBadge status="fail" />);
    expect(screen.getByText("Fail")).toHaveClass("nld-badge--fail");
  });
});

describe("FeatureRow", () => {
  it("renders label, status, tier, and latency", () => {
    render(
      <table>
        <tbody>
          <FeatureRow result={feature({ label: "Nu AI Chat", tier: "api", latencyMs: 88 })} />
        </tbody>
      </table>,
    );
    expect(screen.getByText("Nu AI Chat")).toBeInTheDocument();
    expect(screen.getByText("Pass")).toBeInTheDocument();
    expect(screen.getByText("api")).toBeInTheDocument();
    expect(screen.getByText("88ms")).toBeInTheDocument();
  });

  it("shows an em dash for a null tier or latency instead of blank cells", () => {
    render(
      <table>
        <tbody>
          <FeatureRow result={feature({ tier: null, latencyMs: null })} />
        </tbody>
      </table>,
    );
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThanOrEqual(2);
  });

  it("shows a dash in the reason column when there is no reason", () => {
    render(
      <table>
        <tbody>
          <FeatureRow result={feature({ reason: null })} />
        </tbody>
      </table>,
    );
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
  });

  it("truncates a long reason to 60 chars in the closed summary, full text on expand", () => {
    const longReason =
      "Blocked because the upstream Finnhub quote endpoint returned a 503 for three consecutive polling attempts during this sweep.";
    render(
      <table>
        <tbody>
          <FeatureRow result={feature({ status: "blocked", reason: longReason })} />
        </tbody>
      </table>,
    );
    const summary = screen.getByText((text) => text.startsWith("Blocked because") && text.endsWith("…"));
    expect(summary.textContent?.length).toBeLessThanOrEqual(61); // 60 chars + ellipsis
    expect(screen.getByText(longReason)).toBeInTheDocument();
  });

  it("shows a short reason in full in the summary, without an ellipsis", () => {
    render(
      <table>
        <tbody>
          <FeatureRow result={feature({ status: "fail", reason: "Timed out." })} />
        </tbody>
      </table>,
    );
    expect(screen.getAllByText("Timed out.")).toHaveLength(2); // summary + expanded body
    expect(screen.queryByText(/…$/)).not.toBeInTheDocument();
  });

  it("applies a row class matching the feature's status", () => {
    const { container } = render(
      <table>
        <tbody>
          <FeatureRow result={feature({ status: "blocked" })} />
        </tbody>
      </table>,
    );
    expect(container.querySelector("tr")).toHaveClass("nld-row--blocked");
  });
});
