import type { Metadata } from "next";
import Link from "next/link";
import { coverageReport } from "@/lib/shared/se1-dossier";
import { BUILT_FEEDS, FEED_LABEL, SEED_CARDS, computeGaps } from "@/lib/shared/se1-catalog";
import "../scans.css";

export const metadata: Metadata = {
  title: "What we can't answer yet",
  description: "Scan families that are blocked on a data feed that isn't built, and how many cards exist per family.",
};

/** G6: gap list. Blocked means a needed feed is not built; unblocked still shows unwritten cards. */
export default function GapsPage() {
  const gaps = computeGaps();
  const blocked = gaps.filter((g) => g.missingFeeds.length > 0);
  const cov = coverageReport(SEED_CARDS);
  return (
    <main className="ev-page">
      <p><Link href="/scans">← All scans</Link></p>
      <h1>What we can&apos;t answer yet</h1>
      <p>
        {blocked.length} of {gaps.length} families need a data feed that isn&apos;t built. Built feeds:{" "}
        {BUILT_FEEDS.map((f) => FEED_LABEL[f]).join(", ")}. {cov.written} of {cov.planned} cards are written, {cov.blocked} families blocked.
      </p>
      <table className="ev-table">
        <thead><tr><th>Family</th><th>Phase</th><th>Cards written</th><th>Blocked on</th></tr></thead>
        <tbody>
          {gaps.map((g) => (
            <tr key={g.family.code}>
              <td>{g.family.name}</td>
              <td>{g.family.phase}</td>
              <td>{g.cardsWritten} of {g.cardsPlanned}</td>
              <td>{g.missingFeeds.length ? g.missingFeeds.map((f) => FEED_LABEL[f]).join(", ") : "Nothing: uses built feeds"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
