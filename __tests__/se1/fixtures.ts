import type { EvidenceLevel, ScanCard } from "@/lib/shared/se1-catalog";
import type { Dossier, ScanRow } from "@/lib/shared/se1-dossier";

export const PROV = { source: "se1 fixture", feed: "alpaca_bars", as_of: "2026-11-08", scan_version: "1.0.0" };
export const GC = "se1.trend.golden_cross_recency";
export const EX = "se1.trend.exit_close_under_200";
export const RSI = "se1.mom.rsi_oversold";
export const VOL = "se1.risk.drawdown_depth";

export function row(scan_id: string, flag: boolean, evidence_level: EvidenceLevel = "E1", extra: Partial<ScanRow> = {}): ScanRow {
  return { scan_id, ticker: "AAPL", flag, evidence_level, provenance: PROV, ...extra };
}

export function dossier(rows: ScanRow[], missing: Dossier["missing"] = [], ticker = "AAPL", as_of = "2026-11-08"): Dossier {
  return { ticker, as_of, rows, missing };
}

export function card(id: string, over: Partial<ScanCard> = {}): ScanCard {
  return {
    id, version: "1.0.0", title: id, family: "trend", role: "screen", question: "", status: "spec", evidence_level: "E0",
    source_ref: "fixture", feed: "alpaca_bars", output_fields: {}, caveats: [], composes_with: [], contradicts: [], prose: "",
    ...over,
  };
}
