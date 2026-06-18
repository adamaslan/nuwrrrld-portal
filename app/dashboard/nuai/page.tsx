import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { hasEntitlement, tierFromStatus } from "@/lib/subscription";
import type { SubscriptionStatus } from "@/lib/subscription";
import { NuAIChat } from "./NuAIChat";
import "./nuai.css";

export const metadata: Metadata = {
  title: "Nu AI · NuWrrrld Financial",
};

export default async function NuAIPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in?redirect_url=/dashboard/nuai");

  const user = await currentUser();
  const status = (user?.publicMetadata?.subscription_status as SubscriptionStatus) ?? "free";
  const tier = tierFromStatus(status);

  if (!hasEntitlement("nu_ai", tier)) {
    redirect("/pricing?source=nuai");
  }

  return (
    <main className="nuai-page">
      <div className="nuai-page-header">
        <Link href="/dashboard" className="nuai-back">← Dashboard</Link>
        <h1>Nu AI Assistant</h1>
      </div>
      <NuAIChat />
    </main>
  );
}
