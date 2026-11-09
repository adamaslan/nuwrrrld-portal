/**
 * se1-roadmap2 — five more pure C0 features (roadmap 2): F1, C9, E3, E1, D4.
 * No I/O, no model calls. Nothing calls these yet (logic_only). Each fails closed:
 * a missing input is reported as missing, never filled with a neutral value.
 */
import { evidenceRank } from "./se1-catalog";
import { missingProvenance } from "./ai-features";
import type { ScanRow } from "./se1-dossier";

const byStrength = (a: ScanRow, b: ScanRow) =>
  evidenceRank(b.evidence_level) - evidenceRank(a.evidence_level) || a.scan_id.localeCompare(b.scan_id);

/** A row can back a claim only if it has full provenance. */
const isSourced = (r: ScanRow) => missingProvenance(r.provenance).length === 0;

export interface RankedRows { rows: ScanRow[]; skipped: { scan_id: string; why: string }[] }

function rankSourced(rows: readonly ScanRow[], onlyFlagged: boolean, limit: number): RankedRows {
  const seen = new Set<string>();
  const usable: ScanRow[] = [];
  const skipped: RankedRows["skipped"] = [];
  for (const r of rows) {
    if (seen.has(r.scan_id)) { skipped.push({ scan_id: r.scan_id, why: "duplicate row" }); continue; }
    seen.add(r.scan_id);
    if (onlyFlagged && !r.flag) continue;
    if (!isSourced(r)) { skipped.push({ scan_id: r.scan_id, why: "missing provenance" }); continue; }
    usable.push(r);
  }
  return { rows: usable.sort(byStrength).slice(0, limit), skipped };
}

export const HOLD_FOLD_MAX_REASONS = 5;
export const QUICK_ASK_MAX_SCANS = 3;

/** F1: up to five flagged, sourced rows behind a Hold/Fold call. Fewer is fine; none are invented. */
export function holdFoldReasons(rows: readonly ScanRow[]): RankedRows {
  return rankSourced(rows, true, HOLD_FOLD_MAX_REASONS);
}

/**
 * C9: the top (at most three) scans behind a quick-ask answer. `cited` are the ids the answer used;
 * ids with no sourced row are reported in `unresolved`, never replaced by filler.
 */
export function topScansBehindAnswer(cited: readonly string[], rows: readonly ScanRow[]) {
  const wanted = new Set(cited);
  const ranked = rankSourced(rows.filter((r) => wanted.has(r.scan_id)), false, QUICK_ASK_MAX_SCANS);
  const have = new Set(rows.filter((r) => isSourced(r)).map((r) => r.scan_id));
  const unresolved = [...wanted].filter((id) => !have.has(id)).sort();
  return { rows: ranked.rows, unresolved };
}

export interface Holding {
  ticker: string;
  /** Portfolio weight, > 0. */
  weight: number;
  /** 0-100, higher = stronger trend. null/undefined = not computed. */
  trend?: number | null;
  /** 0-100, higher = riskier. null/undefined = not computed. */
  risk?: number | null;
}

const isScore = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 100;

export interface WeakestLink {
  ranked: { ticker: string; weakness: number }[];
  excluded: { ticker: string; why: string }[];
}

/** E3: rank holdings by weakness = ((100 - trend) + risk) / 2. A holding missing either input is excluded and explained. */
export function weakestLinks(holdings: readonly Holding[]): WeakestLink {
  const ranked: WeakestLink["ranked"] = [];
  const excluded: WeakestLink["excluded"] = [];
  for (const h of holdings) {
    const gaps = [!isScore(h.trend) && "trend", !isScore(h.risk) && "risk"].filter(Boolean);
    if (gaps.length > 0) { excluded.push({ ticker: h.ticker, why: `missing or invalid ${gaps.join(" and ")}` }); continue; }
    ranked.push({ ticker: h.ticker, weakness: (100 - (h.trend as number) + (h.risk as number)) / 2 });
  }
  ranked.sort((a, b) => b.weakness - a.weakness || a.ticker.localeCompare(b.ticker));
  return { ranked, excluded };
}

export interface PortfolioRisk {
  /** Weight-averaged risk over covered holdings, or null when none are covered. */
  risk: number | null;
  /** Covered weight / total weight, 0 to 1. */
  coverage: number;
  complete: boolean;
  missing: string[];
}

/** E1: portfolio risk. Holdings with no risk score are listed as missing and never counted as zero risk. */
export function portfolioRisk(holdings: readonly Holding[]): PortfolioRisk {
  const valid = holdings.filter((h) => Number.isFinite(h.weight) && h.weight > 0);
  const total = valid.reduce((s, h) => s + h.weight, 0);
  const covered = valid.filter((h) => isScore(h.risk));
  const missing = valid.filter((h) => !isScore(h.risk)).map((h) => h.ticker).sort();
  const cw = covered.reduce((s, h) => s + h.weight, 0);
  return {
    risk: cw > 0 ? covered.reduce((s, h) => s + h.weight * (h.risk as number), 0) / cw : null,
    coverage: total > 0 ? cw / total : 0,
    complete: total > 0 && missing.length === 0,
    missing,
  };
}

export interface RegimeObs { as_of: string; regime: string | null }
export type RegimeBanner =
  | { state: "unavailable"; why: string }
  | { state: "stable"; current: string }
  | { state: "changed"; current: string; previous: string };

/**
 * D4: regime-change banner, debounced. A regime counts only after `minRun` consecutive observations;
 * a null observation breaks the run, and a null latest observation means unavailable (not "stable").
 */
export function regimeBanner(history: readonly RegimeObs[], minRun = 2): RegimeBanner {
  if (!Number.isInteger(minRun) || minRun < 1) return { state: "unavailable", why: "invalid debounce length" };
  const last = history[history.length - 1];
  if (!last || last.regime === null) return { state: "unavailable", why: "latest regime is missing" };
  const runs: { regime: string; len: number }[] = [];
  let open: { regime: string; len: number } | null = null;
  for (const o of history) {
    if (o.regime === null) { open = null; continue; }
    if (open && open.regime === o.regime) open.len += 1;
    else { open = { regime: o.regime, len: 1 }; runs.push(open); }
  }
  const confirmed = runs.filter((r) => r.len >= minRun);
  const latest = runs[runs.length - 1];
  if (latest.len < minRun) return { state: "unavailable", why: "latest regime not yet confirmed" };
  const prior = confirmed.length >= 2 ? confirmed[confirmed.length - 2] : undefined;
  return prior && prior.regime !== latest.regime
    ? { state: "changed", current: latest.regime, previous: prior.regime }
    : { state: "stable", current: latest.regime };
}
