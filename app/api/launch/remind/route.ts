/**
 * POST /api/launch/remind — send a Product Hunt upvote reminder.
 * Called once on launch day via cron or manual trigger.
 * Requires LAUNCH_REMIND_SECRET (bearer token) + DISCORD_FEEDBACK_WEBHOOK_URL for logging.
 * Actual email delivery is via the selected provider: Resend by default (RESEND_API_KEY),
 * or Brevo when ALERT_EMAIL_PROVIDER=brevo (BREVO_API_KEY).
 */
import { NextRequest, NextResponse } from "next/server";
import { bearerTokenMatches } from "@/lib/http-auth";
import type { EmailProvider } from "@/lib/notify/email";
import { selectEmailProvider } from "@/lib/notify/select";

const PH_URL = "https://www.producthunt.com/posts/nuwrrrld-financial";
const SITE_URL = "https://financial.nuwrrrld.com";

export async function POST(req: NextRequest) {
  const secret = process.env.LAUNCH_REMIND_SECRET;
  if (!bearerTokenMatches(req.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let provider: EmailProvider;
  try {
    provider = selectEmailProvider(process.env);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "email provider not configured" }, { status: 503 });
  }

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

  // Send individually — putting all addresses in `to` exposes recipients to each other.
  let sent = 0;
  let failed = 0;
  for (const address of recipients) {
    const res = await provider.send({
      from: "NuWrrrld Financial <noreply@financial.nuwrrrld.com>",
      to: [address],
      subject: "We launched today — upvote us on Product Hunt?",
      html,
    }, { timeoutMs: 10_000 });
    if (res.ok) { sent++; } else {
      failed++;
      // Preserve the existing Resend log prefix used by alerting.
      const errorPrefix = provider.name === "resend" ? "Resend error for" : "brevo error for";
      console.error(errorPrefix, address, await res.errorText());
    }
  }

  console.log(`[launch/remind] sent=${sent} failed=${failed}`);
  return NextResponse.json({ sent, failed });
}
