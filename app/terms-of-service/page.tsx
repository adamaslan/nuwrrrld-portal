import Link from "next/link";
import type { Metadata } from "next";
import "../legal.css";

export const metadata: Metadata = {
  title: "Terms of Service · NuWrrrld Financial",
  description: "The terms governing your use of NuWrrrld Financial.",
};

// PLACEHOLDER terms — NON-BINDING scaffold. Must be replaced with attorney-reviewed
// copy before launch. See homebase/legal-todo.md.
if (process.env.NODE_ENV === "production" && process.env.LEGAL_COPY_APPROVED !== "true") {
  console.warn("[NWF] Terms of Service page is still placeholder copy. Set LEGAL_COPY_APPROVED=true after attorney review.");
}

const LAST_UPDATED = "2026-06-13";

export default function TermsOfService() {
  return (
    <div className="nwf-legal">
      <div className="legal-topbar">
        <Link className="brand" href="/">
          <span className="brand-mark" aria-hidden="true">NWF</span>
          <span>NuWrrrld Financial</span>
        </Link>
        <Link className="legal-back" href="/">← Back</Link>
      </div>

      <main className="legal-wrap">
        <h1>Terms of Service</h1>
        <p className="legal-updated">Last updated: {LAST_UPDATED}</p>

        <div className="legal-notice" role="note">
          ⚠️ Draft / placeholder. This page exists so account sign-up can link to
          it; the content has not been reviewed by counsel and is not yet binding.
        </div>

        <h2>1. Not financial or investment advice</h2>
        <p>
          NuWrrrld Financial provides informational tools, market briefings,
          signals, and AI-generated analysis (including Hold/Fold verdicts and
          the AI council). <strong>This is information and software, not
          personalized financial, investment, legal, or tax advice.</strong> No
          fiduciary or advisory relationship is created by your use of the
          service. You are solely responsible for your own investment decisions
          and should consult a licensed professional before acting.
        </p>

        <h2>2. AI output disclaimer</h2>
        <p>
          AI-generated content may be inaccurate, incomplete, or out of date.
          Outputs are probabilistic and must not be relied upon as statements of
          fact. Always perform your own due diligence.
        </p>

        <h2>3. Acceptable use</h2>
        <p>
          You agree not to misuse the service, attempt to circumvent access
          controls, or use it for unlawful purposes. We may suspend or terminate
          accounts that violate these terms.
        </p>

        <h2>4. Subscriptions and billing</h2>
        <p>
          Paid features are billed through our payment processor. Billing terms,
          renewals, and cancellation are described at the point of purchase.
        </p>

        <h2>5. No warranty; limitation of liability</h2>
        <p>
          The service is provided “as is” without warranties of any kind. To the
          maximum extent permitted by law, NuWrrrld Financial is not liable for
          any trading losses or other damages arising from your use of the
          service.
        </p>

        <h2>6. Privacy</h2>
        <p>
          Your use of the service is also governed by our{" "}
          <Link className="inline" href="/privacy-policy">Privacy Policy</Link>.
        </p>

        <h2>7. Changes to these terms</h2>
        <p>
          We may update these terms. Material changes will update the “Last
          updated” date above, and continued use after changes constitutes
          acceptance.
        </p>

        <h2>8. Contact</h2>
        <p>
          Questions about these terms:{" "}
          <a className="inline" href="mailto:chillcoders@gmail.com">
            chillcoders@gmail.com
          </a>
          .
        </p>

        <p className="legal-footer">
          © {new Date().getFullYear()} NuWrrrld Financial. Placeholder terms —
          replace with counsel-reviewed copy before launch.
        </p>
      </main>
    </div>
  );
}
