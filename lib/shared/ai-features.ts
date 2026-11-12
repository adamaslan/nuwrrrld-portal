/**
 * ai-features — the shared feature registry (plan §2 rule 4,
 * docs/nwf-ai-native-10x-plan-2026-10-31.md in homebase).
 *
 * A feature is a recipe + renderer + trigger (+ optional narrator). This file is
 * the single list web and mobile read, so a feature added here appears on both.
 * Wave 0 only: features that need no se1 scan results, just the scan-card contract.
 * Pure data and pure helpers; no I/O. Kept free of web-only imports so it can be
 * copied byte-identical into gcp3-mobile (add it to scripts/check-shared-drift.mjs
 * when the mobile copy lands).
 */

/** C0 no model call · C1 one small-model narration · C2 council. Default is C0. */
export type CostClass = "C0" | "C1" | "C2";
export type Surface = "web" | "mobile" | "both";
/**
 * shipped: live on a surface. web_only: rendered on web, no caller in mobile yet.
 * logic_only: pure functions with tests but no route or component calls them yet.
 * planned: not built.
 */
export type FeatureStatus = "shipped" | "web_only" | "logic_only" | "planned";

export interface AiFeature {
  /** Plan ID, e.g. G1. */
  id: string;
  title: string;
  track: string;
  /** Earliest se1 phase it needs. */
  se1: "P0" | "P1" | "P2" | "P3" | "P4";
  surface: Surface;
  cost: CostClass;
  status: FeatureStatus;
  /** Web route or artifact, when the feature has one. */
  route?: string;
}

export const WAVE0_FEATURES: readonly AiFeature[] = [
  { id: "REG", title: "Shared AI feature registry", track: "Foundation", se1: "P0", surface: "both", cost: "C0", status: "web_only" },
  { id: "G1", title: "Evidence badge (E0 to E4)", track: "Explainability", se1: "P0", surface: "both", cost: "C0", status: "web_only" },
  { id: "G2", title: "Scan card viewer", track: "Explainability", se1: "P0", surface: "both", cost: "C0", status: "web_only", route: "/scans/[id]" },
  { id: "G6", title: "Gap list: what we can't answer yet", track: "Explainability", se1: "P0", surface: "both", cost: "C0", status: "web_only", route: "/scans/gaps" },
  { id: "G7", title: "Scan encyclopedia browser", track: "Explainability", se1: "P0", surface: "web", cost: "C0", status: "web_only", route: "/scans" },
  { id: "G9", title: "Provenance footer", track: "Explainability", se1: "P0", surface: "both", cost: "C0", status: "web_only" },
  { id: "A3", title: "Scan-ID citations that open the card", track: "Ask", se1: "P0", surface: "both", cost: "C0", status: "logic_only" },
  { id: "A9", title: "Explain this scan from the card's prose", track: "Ask", se1: "P0", surface: "both", cost: "C0", status: "web_only", route: "/scans/[id]" },
  { id: "I1", title: "Public llms.txt for se1", track: "External", se1: "P0", surface: "web", cost: "C0", status: "web_only", route: "/llms.txt" },
  { id: "A7", title: "Evidence-level filter", track: "Ask", se1: "P0", surface: "web", cost: "C0", status: "web_only", route: "/scans?min=E1" },
];

/** Pure-logic features built on dossier rows (lib/shared/se1-dossier.ts). Logic only; no live data feeds them yet. */
export const LOGIC_FEATURES: readonly AiFeature[] = [
  { id: "B7", title: "Dossier diff: what changed since last time", track: "Dossiers", se1: "P1", surface: "both", cost: "C0", status: "logic_only" },
  { id: "B9", title: "Dossier export to markdown", track: "Dossiers", se1: "P1", surface: "web", cost: "C0", status: "logic_only" },
  { id: "C4", title: "Council missing-evidence section", track: "Council", se1: "P1", surface: "both", cost: "C0", status: "logic_only" },
  { id: "D6", title: "Contradiction alert (two E3+ scans disagree)", track: "Monitoring", se1: "P1", surface: "both", cost: "C0", status: "logic_only" },
  { id: "D9", title: "Quiet hours and per-ticker alert budgets", track: "Monitoring", se1: "P1", surface: "both", cost: "C0", status: "logic_only" },
  { id: "F2", title: "Hold/Fold confidence as an evidence level", track: "Hold/Fold", se1: "P1", surface: "both", cost: "C0", status: "logic_only" },
  { id: "G5", title: "Scan contradiction graph", track: "Explainability", se1: "P1", surface: "web", cost: "C0", status: "web_only", route: "/scans/graph" },
  { id: "J2", title: "Narration faithfulness check", track: "Operations", se1: "P1", surface: "both", cost: "C0", status: "logic_only" },
  { id: "J5", title: "Near-duplicate scan detector", track: "Operations", se1: "P1", surface: "web", cost: "C0", status: "logic_only" },
  { id: "J9", title: "Coverage report (built vs spec vs blocked)", track: "Operations", se1: "P1", surface: "web", cost: "C0", status: "web_only", route: "/scans/gaps" },
];

export const ALL_FEATURES: readonly AiFeature[] = [...WAVE0_FEATURES, ...LOGIC_FEATURES];

export function featureById(id: string): AiFeature | undefined {
  return ALL_FEATURES.find((f) => f.id === id);
}

/** Share of features that need no model call (plan success measure M2 counts C0). */
export function c0Share(features: readonly AiFeature[] = WAVE0_FEATURES): number {
  if (features.length === 0) return 0;
  return features.filter((f) => f.cost === "C0").length / features.length;
}

/**
 * G9: where a result came from. Plan G5 requires every result row to carry
 * source, feed, as_of and scan_version; the footer fails closed on a missing field.
 */
export interface Provenance {
  source: string;
  feed: string;
  /** ISO date or timestamp the data is as of. */
  as_of: string;
  scan_version: string;
}

const PROVENANCE_KEYS: readonly (keyof Provenance)[] = ["source", "feed", "as_of", "scan_version"];

export function missingProvenance(p: Partial<Provenance>): (keyof Provenance)[] {
  return PROVENANCE_KEYS.filter((k) => !p[k] || String(p[k]).trim() === "");
}

/** Returns the footer line, or null when any field is missing (fail closed: show nothing as sourced). */
export function formatProvenance(p: Partial<Provenance>): string | null {
  if (missingProvenance(p).length > 0) return null;
  return `Source ${p.source} · feed ${p.feed} · as of ${p.as_of} · scan v${p.scan_version}`;
}
