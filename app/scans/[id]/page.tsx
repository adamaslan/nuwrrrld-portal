import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ScanCardView } from "@/components/evidence/ScanCardView";
import { ExplainScan } from "@/components/evidence/ExplainScan";
import { flagLive } from "@/lib/flags";
import { SEED_CARDS, findCard } from "@/lib/shared/se1-catalog";
import "../scans.css";

export function generateStaticParams() {
  return SEED_CARDS.map((c) => ({ id: c.id }));
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const card = findCard(SEED_CARDS, (await params).id);
  return card ? { title: card.title, description: card.question } : { title: "Scan not found" };
}

export default async function ScanCardPage({ params }: { params: Promise<{ id: string }> }) {
  const card = findCard(SEED_CARDS, (await params).id);
  if (!card) notFound();
  return (
    <main className="ev-page">
      <p><Link href="/scans">← All scans</Link></p>
      <ScanCardView card={card} />
      {flagLive("scan_ai_assist") && <ExplainScan cardId={card.id} />}
    </main>
  );
}
