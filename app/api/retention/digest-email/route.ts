/**
 * POST /api/retention/digest-email
 * Sends the weekly signal digest email for a single user.
 * Called by a cron job (every Monday 08:00 UTC) with CRON_SECRET bearer.
 * Body: { userId: string }
 */
import { NextRequest, NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";

const SITE_URL = "https://financial.nuwrrrld.com";
const MCP_URL = process.env.MCP_BACKEND_URL;

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const secret = process.env.CRON_SECRET;
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return NextResponse.json({ error: "RESEND_API_KEY not set" }, { status: 503 });
  if (!MCP_URL) return NextResponse.json({ error: "MCP_BACKEND_URL not set" }, { status: 503 });

  const body = await req.json().catch(() => ({})) as { userId?: string };
  const userId = typeof body.userId === "string" ? body.userId : "";
  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

  const clerk = await clerkClient();
  const user = await clerk.users.getUser(userId);
  const email = user.emailAddresses?.[0]?.emailAddress;
  if (!email) return NextResponse.json({ error: "no email" }, { status: 400 });

  const prefs = user.privateMetadata?.retentionPrefs as { emailDigest?: string } | undefined;
  if (prefs?.emailDigest === "off") return NextResponse.json({ skipped: true });

  // Fetch top 3 signals for the digest summary.
  let signalHtml = "<p>No signals available this week.</p>";
  try {
    const sRes = await fetch(`${MCP_URL}/api/signals/digest`, { headers: { "X-Cron": "true" } });
    if (sRes.ok) {
      const data = await sRes.json() as { signals?: Array<{ ticker?: string; title?: string; direction?: string }> };
      const top3 = (data.signals ?? []).slice(0, 3);
      if (top3.length > 0) {
        signalHtml = top3.map(s =>
          `<li><strong>${s.ticker ?? ''}</strong> — ${s.title ?? ''} <em>(${s.direction ?? ''})</em></li>`
        ).join("");
        signalHtml = `<ul>${signalHtml}</ul>`;
      }
    }
  } catch { /* signals unavailable — send digest without them */ }

  const html = `
<p>Hi ${user.firstName ?? "there"},</p>
<p>Here are your top signals this week:</p>
${signalHtml}
<p><a href="${SITE_URL}/dashboard/signals" style="background:#2563eb;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold;">See full digest →</a></p>
<p style="font-size:11px;color:#9ca3af;">
  Not financial advice. <a href="${SITE_URL}/dashboard/settings">Manage email preferences</a>
</p>
  `.trim();

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "NuWrrrld Financial <noreply@financial.nuwrrrld.com>",
      to: [email],
      subject: "Your weekly signal digest",
      html,
    }),
  });

  if (!res.ok) return NextResponse.json({ error: "email failed" }, { status: 502 });
  return NextResponse.json({ sent: true, to: email });
}
