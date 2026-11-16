import type { Metadata } from "next";
import Link from "next/link";
import { EvidenceBadge } from "@/components/evidence/EvidenceBadge";
import {
  EVIDENCE_LEVELS, FAMILIES, SEED_CARDS, filterCards, totalPlanned,
  type CardRole, type EvidenceLevel, type FamilyCode,
} from "@/lib/shared/se1-catalog";
import "./scans.css";

export const metadata: Metadata = {
  title: "Scan encyclopedia",
  description: "Every se1 scan card, with its question, caveats and evidence level.",
};

const ROLES: CardRole[] = ["screen", "explain", "confirm", "risk", "value", "context"];

type Params = { family?: string; role?: string; min?: string; q?: string };

/** G7 browser plus A7 evidence-level filter. Unknown filter values are ignored, never trusted. */
export default async function ScansPage({ searchParams }: { searchParams: Promise<Params> }) {
  const p = await searchParams;
  const family = FAMILIES.find((f) => f.code === p.family)?.code as FamilyCode | undefined;
  const role = ROLES.find((r) => r === p.role);
  const minEvidence = EVIDENCE_LEVELS.find((l) => l === p.min) as EvidenceLevel | undefined;
  const cards = filterCards(SEED_CARDS, { family, role, minEvidence, query: p.q?.slice(0, 80) });

  return (
    <main className="ev-page">
      <h1>Scan encyclopedia</h1>
      <p>
        {SEED_CARDS.length} of {totalPlanned()} planned scan cards are written so far. Every card is a spec until
        the evidence harness runs it. <Link href="/scans/gaps">See what we can&apos;t answer yet</Link>.
      </p>
      <form className="ev-filters" method="get" aria-label="Filter scan cards">
        <input name="q" defaultValue={p.q ?? ""} placeholder="Search" aria-label="Search" maxLength={80} />
        <select name="family" defaultValue={family ?? ""} aria-label="Family">
          <option value="">All families</option>
          {FAMILIES.map((f) => <option key={f.code} value={f.code}>{f.name}</option>)}
        </select>
        <select name="role" defaultValue={role ?? ""} aria-label="Role">
          <option value="">All roles</option>
          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <select name="min" defaultValue={minEvidence ?? ""} aria-label="Minimum evidence level">
          <option value="">Any evidence level</option>
          {EVIDENCE_LEVELS.map((l) => <option key={l} value={l}>{l} or higher</option>)}
        </select>
        <button type="submit">Filter</button>
      </form>
      {cards.length === 0 ? (
        <p>No cards match. {minEvidence ? "No scan has reached that evidence level yet." : ""}</p>
      ) : (
        <ul className="ev-list">
          {cards.map((c) => (
            <li key={c.id}>
              <p className="ev-meta"><code>{c.id}</code> · {c.family} · {c.role}</p>
              <h2><Link href={`/scans/${c.id}`}>{c.title}</Link></h2>
              <p>{c.question}</p>
              <EvidenceBadge level={c.evidence_level} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
