import { EVIDENCE_INFO, type EvidenceLevel } from "@/lib/shared/se1-catalog";

/** G1: evidence level travels with every claim (plan §2 rule 2). Text, not colour alone. */
export function EvidenceBadge({ level }: { level: EvidenceLevel }) {
  const info = EVIDENCE_INFO[level];
  return (
    <span className={`ev-badge ev-${level.toLowerCase()}`} title={info.mayClaim}>
      <strong>{level}</strong> {info.label}
    </span>
  );
}
