import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { SharePanel } from "./SharePanel";
import "./share.css";

export const metadata: Metadata = { title: "Share NuWrrrld · Earn a free month" };

export default async function SharePage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in?redirect_url=/dashboard/share");

  return (
    <main className="share-page">
      <Link href="/dashboard" className="share-back">← Dashboard</Link>
      <h1>Share &amp; earn</h1>
      <p className="share-intro">
        Refer a friend and you both get a free month when they subscribe.
        Your referral code is below — share it anywhere.
      </p>
      <SharePanel />
    </main>
  );
}
