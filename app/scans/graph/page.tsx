import type { Metadata } from "next";
import Link from "next/link";
import { SEED_CARDS } from "@/lib/shared/se1-catalog";
import { buildScanGraph } from "@/lib/shared/se1-dossier";
import "../scans.css";

export const metadata: Metadata = { title: "Scan graph", description: "Which scans work together and which disagree." };

/** G5: text-first graph (a table), so it reads on mobile and with a screen reader. */
export default function ScanGraphPage() {
  const { nodes, edges } = buildScanGraph(SEED_CARDS);
  return (
    <main className="ev-page">
      <p><Link href="/scans">← All scans</Link></p>
      <h1>Scan graph</h1>
      <p>{nodes.length} scans, {edges.length} links. &quot;Disagrees&quot; means that if both flag the same ticker, a surface must show the conflict.</p>
      <table className="ev-table">
        <thead><tr><th>Scan</th><th>Link</th><th>Scan</th></tr></thead>
        <tbody>
          {edges.map((e) => (
            <tr key={`${e.kind}${e.from}${e.to}`}>
              <td><Link href={`/scans/${e.from}`}><code>{e.from}</code></Link></td>
              <td>{e.kind === "contradicts" ? "Disagrees with" : "Works with"}</td>
              <td><Link href={`/scans/${e.to}`}><code>{e.to}</code></Link></td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
