/**
 * POST /api/launch/remind — send a Product Hunt upvote reminder.
 * Called once on launch day via cron or manual trigger.
 * Requires LAUNCH_REMIND_SECRET (bearer token) + DISCORD_FEEDBACK_WEBHOOK_URL for logging.
 * Actual email delivery is via Resend (RESEND_API_KEY).
 */
import { NextRequest, NextResponse } from "next/server";

const PH_URL = "https://www.producthunt.com/posts/nuwrrrld-financial";
const SITE_URL = "https://financial.nuwrrrld.com";

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const secret = process.env.LAUNCH_REMIND_SECRET;
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return NextResponse.json({ error: "RESEND_API_KEY not set" }, { status: 503 });

  const body = await req.json().catch(() => ({})) as { to?: string[] };
  const recipients: string[] = Array.isArray(body.to) ? body.to : [];
  if (recipients.length === 0) return NextResponse.json({ error: "no recipients" }, { status: 400 });

  const html = `
<p>Hey,</p>
<p>NuWrrrld Financial launched today on Product Hunt. If you've been enjoying the beta, an upvote would mean a lot — it takes 10 seconds.</p>
<p><a href="${PH_URL}" style="background:#ff6154;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:bold;">Upvote on Product Hunt →</a></p>
<p>And if you haven't started your free trial yet: <a href="${SITE_URL}/pricing">7 days free, no credit card required</a>.</p>
<p>Thank you for being here early.</p>
<p>— Adam<br>NuWrrrld Financial</p>
<p style="font-size:11px;color:#9ca3af;">Nothing in this email is financial advice.</p>
  `.trim();

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "NuWrrrld Financial <noreply@financial.nuwrrrld.com>",
      to: recipients,
      subject: "We launched today — upvote us on Product Hunt?",
      html,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("Resend error", err);
    return NextResponse.json({ error: "email failed" }, { status: 502 });
  }

  console.log(`[launch/remind] sent to ${recipients.length} recipients`);
  return NextResponse.json({ sent: recipients.length });
}
