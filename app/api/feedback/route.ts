import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";
import { redirect } from "next/navigation";

const DISCORD_TIMEOUT_MS = 10_000;

async function parseBody(req: NextRequest): Promise<Record<string, string>> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
    const fd = await req.formData();
    const out: Record<string, string> = {};
    fd.forEach((v, k) => { out[k] = String(v); });
    return out;
  }
  return req.json().catch(() => ({}));
}

export async function POST(req: NextRequest) {
  const { userId } = await auth();

  const body = await parseBody(req);
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const category = typeof body.category === "string" ? body.category : "other";
  const source = typeof body.source === "string" ? body.source : "unknown";
  const platform = typeof body.platform === "string" ? body.platform : "web";

  if (message.length < 3) {
    // Form submissions get a redirect; API callers get JSON.
    const isForm = (req.headers.get("content-type") ?? "").includes("urlencoded");
    if (isForm) return redirect("/dashboard/beta?error=message_required");
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }

  const payload = {
    userId: userId ?? "anonymous",
    category,
    message,
    source,
    platform,
    ts: body.ts ?? new Date().toISOString(),
  };

  const discordUrl = process.env.DISCORD_FEEDBACK_WEBHOOK_URL;
  if (discordUrl) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DISCORD_TIMEOUT_MS);
    try {
      const res = await fetch(discordUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          content: [
            `**[${payload.category.toUpperCase()}]** from \`${payload.userId}\` via ${payload.platform}/${payload.source}`,
            `> ${payload.message}`,
            `_${payload.ts}_`,
          ].join("\n"),
        }),
      });
      if (!res.ok) console.error("Discord webhook returned", res.status);
    } catch (err) {
      console.error("Discord webhook failed", err);
    } finally {
      clearTimeout(timer);
    }
  } else {
    console.log("[feedback]", payload);
  }

  // Redirect form submissions back to the beta page with a success flag.
  const isForm = (req.headers.get("content-type") ?? "").includes("urlencoded");
  if (isForm) return redirect("/dashboard/beta?success=true");
  return NextResponse.json({ received: true });
}
