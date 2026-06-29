export const runtime = 'edge';
import { NextRequest, NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import type { RetentionPreferences } from "@/lib/retention";

const SITE_URL = "https://financial.nuwrrrld.com";
const MAX_NUDGES = 3;

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization") ?? "";
  const secret = process.env.CRON_SECRET;
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return NextResponse.json({ error: "RESEND_API_KEY not set" }, { status: 503 });

  const body = await req.json().catch(() => ({})) as { userId?: string };
  const userId = typeof body.userId === "string" ? body.userId : "";
  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

  const clerk = await clerkClient();
  let user;
  try {
    user = await clerk.users.getUser(userId);
  } catch {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  const verifiedEmail = user.emailAddresses.find(e => e.verification?.status === "verified")?.emailAddress;
  if (!verifiedEmail) return NextResponse.json({ error: "no verified email" }, { status: 400 });

  const prefs = (user.privateMetadata?.retentionPrefs ?? {}) as Partial<RetentionPreferences>;
  const nudgesSeen = prefs.trialNudgesSeen ?? 0;
  if (nudgesSeen >= MAX_NUDGES) return NextResponse.json({ skipped: "max nudges reached" });

  const name = escHtml(user.firstName ?? "there");
  const html = `
<p>Hi ${name},</p>
<p>Your NuWrrrld Financial free trial ends in <strong>48 hours</strong>.</p>
<p>To keep access to your signal digest, Nu AI, and portfolio intelligence, subscribe before your trial ends.</p>
<p><a href="${SITE_URL}/pricing" style="background:#2563eb;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold;">Keep my access →</a></p>
<p>Questions? Reply to this email — I read every one.</p>
<p>— Adam<br>NuWrrrld Financial</p>
<p style="font-size:11px;color:#9ca3af;">Not financial advice.</p>
  `.trim();

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "NuWrrrld Financial <noreply@financial.nuwrrrld.com>",
        to: [verifiedEmail],
        subject: "Your free trial ends in 48 hours",
        html,
      }),
    });
    if (!res.ok) return NextResponse.json({ error: "email failed" }, { status: 502 });
  } catch {
    return NextResponse.json({ error: "network error sending email" }, { status: 502 });
  }

  await clerk.users.updateUserMetadata(userId, {
    privateMetadata: {
      retentionPrefs: { ...prefs, trialNudgesSeen: nudgesSeen + 1 },
    },
  });

  return NextResponse.json({ sent: true });
}
