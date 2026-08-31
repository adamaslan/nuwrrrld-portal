/**
 * followed-tickers-render — unit tests for the doc-section rewriter.
 * Pure string work, no DB, no fs.
 */
import { describe, expect, it } from "vitest";
import {
  MARKERS,
  renderCohort,
  renderJudgeScorecard,
  renderScoreboard,
  replaceSection,
  type CohortRow,
} from "@/lib/followed-tickers-render";

describe("replaceSection", () => {
  const doc = `intro\n${MARKERS.cohort[0]}\nOLD BODY\n${MARKERS.cohort[1]}\noutro`;

  it("replaces only the text between the marker pair", () => {
    const out = replaceSection(doc, MARKERS.cohort, "NEW BODY");
    expect(out).toContain(`${MARKERS.cohort[0]}\nNEW BODY\n${MARKERS.cohort[1]}`);
    expect(out).toContain("intro");
    expect(out).toContain("outro");
    expect(out).not.toContain("OLD BODY");
  });

  it("returns the doc unchanged when the markers are absent — never appends", () => {
    const noMarkers = "just some text";
    expect(replaceSection(noMarkers, MARKERS.cohort, "X")).toBe(noMarkers);
  });

  it("is idempotent", () => {
    const once = replaceSection(doc, MARKERS.cohort, "BODY");
    const twice = replaceSection(once, MARKERS.cohort, "BODY");
    expect(twice).toBe(once);
  });
});

describe("renderCohort", () => {
  const rows: CohortRow[] = [
    {
      ticker: "NVDA",
      direction: "bull",
      added: "2026-09-01",
      entry: 185.5,
      latestSignal: "BUY",
      backtest: "71%",
      council: "bullish",
      judge: 8,
      daysHeld: 4,
      thesisHolding: true,
    },
    {
      ticker: "XYZ",
      direction: "bear",
      added: "2026-09-01",
      entry: 42,
      latestSignal: "BUY",
      backtest: "—",
      council: "neutral",
      judge: null,
      daysHeld: 0,
      thesisHolding: false,
    },
  ];

  it("splits bulls and bears into their own tables", () => {
    const md = renderCohort(rows, "2026-09-01");
    expect(md).toContain("### Bulls (10)");
    expect(md).toContain("### Bears (10)");
    expect(md).toContain("| NVDA | bull | 2026-09-01 | 185.5 |");
    expect(md).toContain("| XYZ | bear |");
  });

  it("marks a broken thesis in bold and renders a null judge as a dash", () => {
    const md = renderCohort(rows, "2026-09-01");
    expect(md).toContain("**no**");
    expect(md).toMatch(/XYZ .*\| — \| 0 \| \*\*no\*\* \|/);
  });

  it("shows the pending placeholder row when a side is empty", () => {
    const md = renderCohort(rows.filter((r) => r.direction === "bull"), "2026-09-01");
    expect(md).toContain("_pending selection run_ | bear");
  });
});

describe("renderScoreboard", () => {
  it("emits an n<30 row for every horizon when there is no data", () => {
    const md = renderScoreboard([], "not yet");
    for (const h of ["d1", "w1", "m1", "m3", "m6", "ytd", "y1"]) {
      expect(md).toContain(`| \`${h}\` | 0 |`);
    }
    expect(md).toContain("**As of:** not yet");
  });

  it("renders a real hit-rate once n reaches 30", () => {
    const scored = [
      ...Array.from({ length: 21 }, () => ({ outcome: "hit" as const, returnPct: 3, directional: 3 })),
      ...Array.from({ length: 9 }, () => ({ outcome: "miss" as const, returnPct: -3, directional: -3 })),
    ];
    const md = renderScoreboard(
      [{ horizon: "w1", scored, baselineRows: [] }],
      "2026-12-01",
    );
    expect(md).toContain("| `w1` | 30 | 21 | 9 | 0 | 0 | 70.0% (n=30)");
  });
});

describe("renderJudgeScorecard", () => {
  it("renders the pending row with the version tag when there are no periods", () => {
    const md = renderJudgeScorecard([], "not yet", "v1");
    expect(md).toContain("**Judge version:** `v1`");
    expect(md).toContain("_pending first judge run_");
  });

  it("renders a graded period with per-criterion means", () => {
    const md = renderJudgeScorecard(
      [
        {
          period: "2026-11-24..2026-11-30",
          verdictsGraded: 12,
          meanTotal: 7.5,
          criteriaMeans: {
            grounding: 1.8,
            falsifiability: 1.5,
            consistency: 1.9,
            specificity: 1.2,
            calibration: 1.1,
          },
          goldAgreement: 0.9,
        },
      ],
      "2026-11-30",
      "v1",
    );
    expect(md).toContain("| 2026-11-24..2026-11-30 | 12 | 7.5 | 1.80 | 1.50 | 1.90 | 1.20 | 1.10 | 90% |");
  });
});
