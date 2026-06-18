import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import "./beta.css";

export const metadata: Metadata = {
  title: "Beta Founders · NuWrrrld Financial",
};

export default async function BetaPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in?redirect_url=/dashboard/beta");

  const user = await currentUser();
  const email = user?.emailAddresses?.[0]?.emailAddress ?? "";

  return (
    <main className="beta-page">
      <div className="beta-header">
        <Link href="/dashboard" className="beta-back">← Dashboard</Link>
        <h1>Beta Founders Program</h1>
        <p className="beta-intro">
          You're one of our founding users. Your feedback directly shapes the product.
          Thank you for being here early.
        </p>
      </div>

      <div className="beta-card">
        <h2>How to reach us</h2>
        <ul className="beta-channels">
          <li>
            <strong>Discord</strong> — join our private founders channel for live discussion
            {" "}<a href="https://discord.gg/nuwrrrld" target="_blank" rel="noreferrer">discord.gg/nuwrrrld</a>
          </li>
          <li>
            <strong>Email</strong> — direct line to the founder:{" "}
            <a href="mailto:chillcoders@gmail.com">chillcoders@gmail.com</a>
          </li>
          <li>
            <strong>In-app</strong> — tap the feedback button (✉️) on any screen
          </li>
        </ul>
      </div>

      <div className="beta-card">
        <h2>What we&apos;re fixing this week</h2>
        <p className="beta-meta">Updated every Monday. Reply to share your top blocker.</p>
        <ul className="beta-list">
          <li>Improving Schwab connection reliability on reconnect</li>
          <li>Faster signal digest load time</li>
          <li>Better error messages when brokerage data is unavailable</li>
        </ul>
      </div>

      <div className="beta-card">
        <h2>Send feedback</h2>
        <FeedbackForm email={email} />
      </div>
    </main>
  );
}

function FeedbackForm({ email }: { email: string }) {
  return (
    <form className="feedback-form" action="/api/feedback" method="POST">
      <input type="hidden" name="source" value="beta-page" />
      <select name="category" className="feedback-select">
        <option value="bug">Bug report</option>
        <option value="feature">Feature request</option>
        <option value="data">Data / signal issue</option>
        <option value="other">Other</option>
      </select>
      <textarea
        name="message"
        className="feedback-textarea"
        placeholder="Tell us what you're experiencing or what you'd like to see…"
        rows={4}
      />
      <p className="feedback-from">Sending as: {email}</p>
      <button type="submit" className="feedback-btn">Send feedback</button>
    </form>
  );
}
