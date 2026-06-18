import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const { userId } = await auth();

  const body = await req.json().catch(() => ({}));
  const { category, message, source, platform, ts } = body;

  if (!message || typeof message !== "string" || message.trim().length < 3) {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }

  const payload = {
    userId: userId ?? "anonymous",
    category: category ?? "other",
    message: message.trim(),
    source: source ?? "unknown",
    platform: platform ?? "web",
    ts: ts ?? new Date().toISOString(),
  };

  // Forward to Discord webhook if configured; otherwise log.
  const discordUrl = process.env.DISCORD_FEEDBACK_WEBHOOK_URL;
  if (discordUrl) {
    await fetch(discordUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: [
          `**[${payload.category.toUpperCase()}]** from \`${payload.userId}\` via ${payload.platform}/${payload.source}`,
          `> ${payload.message}`,
          `_${payload.ts}_`,
        ].join("\n"),
      }),
    }).catch(err => console.error("Discord webhook failed", err));
  } else {
    console.log("[feedback]", payload);
  }

  return NextResponse.json({ received: true });
}
