"use client";

import { useCallback, useEffect, useState } from "react";
import {
  HORIZON_LABEL,
  type CohortCardVM,
  type FollowedTickersViewVM,
  type ScoreboardRowVM,
} from "@/lib/shared/followed-tickers-view";

interface Props {
  initial: FollowedTickersViewVM;
}

type Tab = "cohort" | "scoreboard" | "judge";

export function FollowedTickersClient({ initial }: Props) {
  const [view, setView] = useState<FollowedTickersViewVM>(initial);
  const [tab, setTab] = useState<Tab>("cohort");
  const [refreshing, setRefreshing] = useState(false);
  const [staleError, setStaleError] = useState(false);

  async function loadInto(
    onData: (v: FollowedTickersViewVM) => void,
    onError: () => void,
  ): Promise<void> {
    const res = await fetch("/api/followed-tickers", { cache: "no-store" });
    if (!res.ok) {
      onError();
      return;
    }
    onData((await res.json()) as FollowedTickersViewVM);
  }

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setStaleError(false);
    try {
      await loadInto(setView, () => setStaleError(true));
    } catch {
      setStaleError(true);
    } finally {
      setRefreshing(false);
    }
  }, []);

  // One background refresh on mount so a cached server render catches up to the
  // latest tracking run without blocking first paint. Guarded against a state
  // update after unmount.
  useEffect(() => {
    let live = true;
    loadInto(
      (v) => {
        if (live) setView(v);
      },
      () => {
        if (live) setStaleError(true);
      },
    ).catch(() => {
      if (live) setStaleError(true);
    });
    return () => {
      live = false;
    };
  }, []);

  if (view.empty) {
    return (
      <div className="ft-empty">
        <p>
          No cohort has been selected yet. The first monthly selection run freezes
          20 tickers on the 1st; check back then.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="ft-toolbar">
        <div className="ft-tabs" role="tablist" aria-label="View">
          <button
            role="tab"
            aria-selected={tab === "cohort"}
            className={`ft-tab${tab === "cohort" ? " ft-tab--active" : ""}`}
            onClick={() => setTab("cohort")}
          >
            Cohort
          </button>
          <button
            role="tab"
            aria-selected={tab === "scoreboard"}
            className={`ft-tab${tab === "scoreboard" ? " ft-tab--active" : ""}`}
            onClick={() => setTab("scoreboard")}
          >
            Scoreboard
          </button>
          <button
            role="tab"
            aria-selected={tab === "judge"}
            className={`ft-tab${tab === "judge" ? " ft-tab--active" : ""}`}
            onClick={() => setTab("judge")}
          >
            Judge
          </button>
        </div>
        <div className="ft-meta">
          {view.cohortMonth && <span className="ft-cohort-month">{view.cohortMonth}</span>}
          <button className="ft-refresh" onClick={refresh} disabled={refreshing}>
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {staleError && (
        <p className="ft-stale">⚠ Couldn&apos;t refresh — showing the last loaded data.</p>
      )}

      {tab === "cohort" && <CohortView bulls={view.bulls} bears={view.bears} />}
      {tab === "scoreboard" && (
        <ScoreboardView rows={view.scoreboard} minN={view.minResolvedForRate} />
      )}
      {tab === "judge" && <JudgeView view={view} />}
    </>
  );
}

// ── Cohort ──────────────────────────────────────────────────────────────────

function CohortView({ bulls, bears }: { bulls: CohortCardVM[]; bears: CohortCardVM[] }) {
  return (
    <div className="ft-cohort">
      <section className="ft-side">
        <h2 className="ft-side-title ft-side-title--bull">
          Bulls <span className="ft-side-count">{bulls.length}</span>
        </h2>
        <div className="ft-card-grid">
          {bulls.map((c) => (
            <CohortCard key={c.ticker} card={c} />
          ))}
          {bulls.length === 0 && <p className="ft-side-empty">No bull picks this month.</p>}
        </div>
      </section>
      <section className="ft-side">
        <h2 className="ft-side-title ft-side-title--bear">
          Bears <span className="ft-side-count">{bears.length}</span>
        </h2>
        <div className="ft-card-grid">
          {bears.map((c) => (
            <CohortCard key={c.ticker} card={c} />
          ))}
          {bears.length === 0 && <p className="ft-side-empty">No bear picks this month.</p>}
        </div>
      </section>
    </div>
  );
}

function CohortCard({ card }: { card: CohortCardVM }) {
  const ret = card.directionalReturnPct;
  const retClass =
    ret == null ? "ft-ret--flat" : ret > 0 ? "ft-ret--up" : ret < 0 ? "ft-ret--down" : "ft-ret--flat";

  return (
    <article className={`ft-card ft-card--${card.direction}${card.thesisHolding ? "" : " ft-card--broken"}`}>
      <div className="ft-card-top">
        <span className="ft-card-ticker">{card.ticker}</span>
        <span className={`ft-card-dir ft-card-dir--${card.direction}`}>
          {card.direction === "bull" ? "▲ Bull" : "▼ Bear"}
        </span>
      </div>

      <div className={`ft-card-ret ${retClass}`}>
        {ret == null ? "—" : `${ret > 0 ? "+" : ""}${ret.toFixed(2)}%`}
        <span className="ft-card-ret-label">since entry</span>
      </div>

      <dl className="ft-card-stats">
        <div>
          <dt>Entry</dt>
          <dd>{card.entryPrice.toFixed(2)}</dd>
        </div>
        <div>
          <dt>Last</dt>
          <dd>{card.lastPrice == null ? "—" : card.lastPrice.toFixed(2)}</dd>
        </div>
        <div>
          <dt>Signal</dt>
          <dd className={card.thesisHolding ? "" : "ft-flip"}>
            {card.latestSignal ?? "—"}
          </dd>
        </div>
        <div>
          <dt>Backtest</dt>
          <dd>{card.backtestRatePct == null ? "—" : `${card.backtestRatePct.toFixed(0)}%`}</dd>
        </div>
        <div>
          <dt>Held</dt>
          <dd>{card.daysHeld == null ? "—" : `${card.daysHeld}d`}</dd>
        </div>
        <div>
          <dt>Judge</dt>
          <dd>{card.judgeScore == null ? "—" : `${card.judgeScore}/10`}</dd>
        </div>
      </dl>

      {card.councilOutlook && (
        <p className="ft-card-council">
          Council: <span>{card.councilOutlook}</span>
        </p>
      )}

      {!card.thesisHolding && (
        <p className="ft-card-flag">Thesis flipped — kept in the cohort, still scored</p>
      )}
    </article>
  );
}

// ── Scoreboard ──────────────────────────────────────────────────────────────

function ScoreboardView({ rows, minN }: { rows: ScoreboardRowVM[]; minN: number }) {
  return (
    <div className="ft-scoreboard">
      <p className="ft-scoreboard-lead">
        Outcome accuracy by horizon. <code>n</code> is resolved picks (hits + misses;
        flats and voids counted separately). A rate under <code>n={minN}</code> is not
        published.
      </p>

      {/* Table on wide screens, stacked cards on narrow */}
      <div className="ft-sb-table" role="table">
        <div className="ft-sb-row ft-sb-row--head" role="row">
          <span role="columnheader">Horizon</span>
          <span role="columnheader">n</span>
          <span role="columnheader">Hit</span>
          <span role="columnheader">Miss</span>
          <span role="columnheader">Flat</span>
          <span role="columnheader">Hit-rate</span>
          <span role="columnheader">Mean ret</span>
        </div>
        {rows.map((r) => {
          const rate =
            r.hitRatePct != null
              ? `${r.hitRatePct.toFixed(1)}%`
              : r.notYetAvailable
                ? "—"
                : `n<${minN}`;
          const rateClass =
            r.hitRatePct == null
              ? "ft-sb-rate--pending"
              : r.hitRatePct >= 50
                ? "ft-sb-rate--good"
                : "ft-sb-rate--bad";
          return (
            <div className="ft-sb-row" role="row" key={r.horizon}>
              <span role="cell" data-label="Horizon" className="ft-sb-horizon">
                {HORIZON_LABEL[r.horizon]}
              </span>
              <span role="cell" data-label="n">{r.n}</span>
              <span role="cell" data-label="Hit" className="ft-sb-hit">{r.hits}</span>
              <span role="cell" data-label="Miss" className="ft-sb-miss">{r.misses}</span>
              <span role="cell" data-label="Flat">{r.flats}</span>
              <span role="cell" data-label="Hit-rate" className={`ft-sb-rate ${rateClass}`}>
                {rate}
              </span>
              <span role="cell" data-label="Mean ret">
                {r.meanReturnPct == null
                  ? "—"
                  : `${r.meanReturnPct > 0 ? "+" : ""}${r.meanReturnPct.toFixed(2)}%`}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Judge ───────────────────────────────────────────────────────────────────

function JudgeView({ view }: { view: FollowedTickersViewVM }) {
  const j = view.judge;
  const q = view.quadrant;

  return (
    <div className="ft-judge">
      {j == null ? (
        <p className="ft-judge-empty">
          No verdicts have been graded yet. The weekly judge run grades a sample of
          that week&apos;s council verdicts against a five-criterion rubric.
        </p>
      ) : (
        <div className="ft-judge-score">
          <div className="ft-judge-big">
            {j.meanScore == null ? "—" : j.meanScore.toFixed(1)}
            <span>/10 mean</span>
          </div>
          <p className="ft-judge-count">
            {j.verdictsGraded} verdict{j.verdictsGraded === 1 ? "" : "s"} graded
          </p>
        </div>
      )}

      <h3 className="ft-quadrant-title">Outcome × reasoning quality</h3>
      <p className="ft-quadrant-lead">
        The bottom-left cell is the one to watch: right for no articulable reason.
      </p>
      <div className="ft-quadrant">
        <div className="ft-quad ft-quad--good">
          <span className="ft-quad-label">Hit · judge ≥ 7</span>
          <span className="ft-quad-n">{q.hitHighJudge}</span>
          <span className="ft-quad-note">Working as intended</span>
        </div>
        <div className="ft-quad">
          <span className="ft-quad-label">Miss · judge ≥ 7</span>
          <span className="ft-quad-n">{q.missHighJudge}</span>
          <span className="ft-quad-note">Sound process, unlucky</span>
        </div>
        <div className="ft-quad ft-quad--danger">
          <span className="ft-quad-label">Hit · judge &lt; 7</span>
          <span className="ft-quad-n">{q.hitLowJudge}</span>
          <span className="ft-quad-note">Right for no reason</span>
        </div>
        <div className="ft-quad ft-quad--broken">
          <span className="ft-quad-label">Miss · judge &lt; 7</span>
          <span className="ft-quad-n">{q.missLowJudge}</span>
          <span className="ft-quad-note">Genuinely broken</span>
        </div>
      </div>
    </div>
  );
}
