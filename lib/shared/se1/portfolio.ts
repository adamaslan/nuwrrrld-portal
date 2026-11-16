/**
 * se1/portfolio — track E (portfolio intelligence). Pure logic over fixtures; no I/O, no model call.
 * E1 and E3 are in PR #352. These functions take holdings as arguments and keep nothing.
 */
import { checkFaithfulness, type ScanRow } from "../se1-dossier";
import { cleanText, DAY_MS, daysBetween, localDate, parseIso, pearson, round } from "./util";

// ── E2 ────────────────────────────────────────────────────────────────────────

export interface DatedValue { date: string; value: number }

/** E2: correlation over shared dates only. Too little overlap is insufficient data, never zero. */
export function alignedCorrelation(a: readonly DatedValue[], b: readonly DatedValue[], minOverlap = 20):
  { status: "ok"; r: number; n: number } | { status: "insufficient_data"; reason: string; n: number } {
  const bByDate = new Map(b.filter((x) => Number.isFinite(x.value) && parseIso(x.date) !== null).map((x) => [x.date, x.value]));
  const xs: number[] = [], ys: number[] = [];
  for (const p of a) {
    const v = bByDate.get(p.date);
    if (v !== undefined && Number.isFinite(p.value) && parseIso(p.date) !== null) { xs.push(p.value); ys.push(v); }
  }
  if (xs.length < Math.max(3, minOverlap)) return { status: "insufficient_data", reason: `only ${xs.length} shared dates, needs ${minOverlap}`, n: xs.length };
  const r = pearson(xs, ys);
  if (r === null) return { status: "insufficient_data", reason: "a series is flat over the shared dates", n: xs.length };
  return { status: "ok", r: round(r, 3), n: xs.length };
}

// ── E4 ────────────────────────────────────────────────────────────────────────

export interface WeightedHolding { ticker: string; weight: number }
/** A review item. It has no side, quantity or order field by design. */
export interface ReviewItem { ticker: string; status: "needs_review"; reason: string }

/** E4: positions above the weight cap become review items. Incomplete coverage is returned with the list. */
export function rebalanceCandidates(holdings: readonly WeightedHolding[], maxWeight: number, coverage: { covered: number; total: number }) {
  const items: ReviewItem[] = holdings
    .filter((h) => Number.isFinite(h.weight) && h.weight > maxWeight)
    .map((h) => ({ ticker: h.ticker, status: "needs_review" as const, reason: `weight ${round(h.weight * 100, 1)}% is above the ${round(maxWeight * 100, 1)}% cap` }));
  const complete = coverage.total > 0 && coverage.covered >= coverage.total;
  return {
    items,
    complete,
    disclosure: complete ? null : `Only ${coverage.covered} of ${coverage.total} holdings could be assessed. Candidates may be missing.`,
  };
}

// ── E5 ────────────────────────────────────────────────────────────────────────

/** E5: only grounded sentences may be shown; everything else is returned as rejected. */
export function healthClaimsGate(text: string, rows: readonly ScanRow[]) {
  const r = checkFaithfulness(text, rows);
  return {
    publishable: r.grounded,
    rejected: [...r.ungrounded, ...r.unverifiable.map((s) => ({ sentence: s, why: "claim cites no row" }))],
  };
}

/** E5: health results are cached per user and per holdings snapshot. A missing part throws. */
export function healthCacheKey(userId: string, holdingsHash: string): string {
  if (!userId || !holdingsHash) throw new TypeError("healthCacheKey: user id and holdings hash are required");
  return `health:${encodeURIComponent(userId)}:${encodeURIComponent(holdingsHash)}`;
}

// ── E6 ────────────────────────────────────────────────────────────────────────

export interface HoldingsSnapshot { as_of: string; positions: readonly { ticker: string; weight: number; beta: number | null }[] }
export interface RegimeSnapshot { as_of: string; regime: "risk_on" | "risk_off" | "neutral" | null }

/** E6: fit is "unknown" whenever either snapshot is missing, stale or incomplete. There is no default label. */
export function regimeFit(holdings: HoldingsSnapshot | null, regime: RegimeSnapshot | null, asOf: string, maxAgeDays: number):
  { fit: "aligned" | "misaligned" | "neutral"; weighted_beta: number } | { fit: "unknown"; reason: string } {
  const now = parseIso(asOf);
  if (now === null) return { fit: "unknown", reason: "invalid asOf" };
  if (!holdings || holdings.positions.length === 0) return { fit: "unknown", reason: "no holdings snapshot" };
  if (!regime || regime.regime === null) return { fit: "unknown", reason: "no regime reading" };
  for (const [name, s] of [["holdings", holdings.as_of], ["regime", regime.as_of]] as const) {
    const t = parseIso(s);
    if (t === null || now - t > maxAgeDays * DAY_MS) return { fit: "unknown", reason: `${name} snapshot is stale or undated` };
  }
  const noBeta = holdings.positions.filter((p) => p.beta === null || !Number.isFinite(p.beta));
  if (noBeta.length) return { fit: "unknown", reason: `beta missing for ${noBeta.length} position(s)` };
  const totalW = holdings.positions.reduce((s, p) => s + p.weight, 0);
  if (!(totalW > 0)) return { fit: "unknown", reason: "weights do not sum to a positive total" };
  const beta = holdings.positions.reduce((s, p) => s + p.weight * (p.beta as number), 0) / totalW;
  const wb = round(beta, 2);
  if (regime.regime === "neutral" || Math.abs(beta - 1) < 0.1) return { fit: "neutral", weighted_beta: wb };
  const aggressive = beta > 1;
  return { fit: (regime.regime === "risk_on") === aggressive ? "aligned" : "misaligned", weighted_beta: wb };
}

// ── E7 ────────────────────────────────────────────────────────────────────────

export interface TimedEvent { ticker: string; at: string; status: "scheduled" | "cancelled"; updated_at: string }

/** E7: dollar exposure per exchange-local day for one week. The latest update per ticker wins; days sum to the week. */
export function exposureCalendar(
  holdings: readonly { ticker: string; value: number }[],
  events: readonly TimedEvent[],
  weekStart: string,
  timeZone = "America/New_York",
) {
  const start = parseIso(weekStart);
  if (start === null) return { ok: false as const, error: "invalid weekStart" };
  const days = Array.from({ length: 7 }, (_, i) => new Date(start + i * DAY_MS).toISOString().slice(0, 10));
  const latest = new Map<string, TimedEvent>();
  for (const e of events) {
    const prev = latest.get(e.ticker);
    if (!prev || (parseIso(e.updated_at) ?? -Infinity) > (parseIso(prev.updated_at) ?? -Infinity)) latest.set(e.ticker, e);
  }
  const value = new Map(holdings.filter((h) => Number.isFinite(h.value)).map((h) => [h.ticker, h.value]));
  const byDay: Record<string, { tickers: string[]; total: number }> = Object.fromEntries(days.map((d) => [d, { tickers: [], total: 0 }]));
  for (const e of latest.values()) {
    if (e.status !== "scheduled" || !value.has(e.ticker)) continue;
    const t = parseIso(e.at);
    const day = t === null ? null : localDate(new Date(t), timeZone);
    if (day && byDay[day]) { byDay[day].tickers.push(e.ticker); byDay[day].total += value.get(e.ticker) as number; }
  }
  const weekTotal = Object.values(byDay).reduce((s, d) => s + d.total, 0);
  return { ok: true as const, days: byDay, weekTotal };
}

// ── E8 ────────────────────────────────────────────────────────────────────────

export interface Filing { period_end: string; filed_at: string; value: number }

/** E8: the value known on a date: latest period filed by then, and for that period the latest filing by then.
 *  A later amendment never replaces what was known earlier. */
export function valueAsOf(filings: readonly Filing[], date: string): Filing | null {
  const cutoff = parseIso(date);
  if (cutoff === null) return null;
  const known = filings.filter((f) => {
    const t = parseIso(f.filed_at);
    return t !== null && t <= cutoff && parseIso(f.period_end) !== null && Number.isFinite(f.value);
  });
  if (known.length === 0) return null;
  return known.reduce((best, f) =>
    f.period_end > best.period_end || (f.period_end === best.period_end && f.filed_at > best.filed_at) ? f : best);
}

/** E8: drift between two dates, each using only what was filed by then. */
export function fundamentalsDrift(filings: readonly Filing[], from: string, to: string) {
  const a = valueAsOf(filings, from), b = valueAsOf(filings, to);
  if (!a || !b) return { available: false as const, reason: !a ? `nothing filed by ${from}` : `nothing filed by ${to}` };
  return { available: true as const, from: a, to: b, change: b.value - a.value };
}

// ── E9 ────────────────────────────────────────────────────────────────────────

export interface OwnershipFiling { holder: string; shares: number; period_end: string; filed_at: string }

/** E9: an ownership line always names the period, the filing date and the lag. It never reads as live ownership. */
export function ownershipLine(f: OwnershipFiling): { available: true; text: string; lag_days: number } | { available: false; reason: string } {
  const lag = daysBetween(f.period_end, f.filed_at);
  if (lag === null) return { available: false, reason: "filing has no valid period or filing date" };
  if (lag < 0) return { available: false, reason: "filing date is before the period end" };
  if (!Number.isFinite(f.shares) || f.shares < 0) return { available: false, reason: "invalid share count" };
  const holder = cleanText(f.holder, 120) || "A filer";
  return {
    available: true,
    lag_days: lag,
    text: `${holder} reported ${f.shares.toLocaleString("en-US")} shares as of ${f.period_end}, filed ${f.filed_at} (${lag} days later). This is as of the filing, not current ownership.`,
  };
}
