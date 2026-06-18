import Link from "next/link";
import type { Metadata } from "next";
import "../legal.css";

export const metadata: Metadata = {
  title: "Privacy Policy · NuWrrrld Financial",
  description: "How NuWrrrld Financial collects, uses, and protects your data.",
};

// PLACEHOLDER policy — NON-BINDING scaffold. Must be replaced with attorney-reviewed
// copy before launch. See homebase/legal-todo.md.
if (process.env.NODE_ENV === "production" && process.env.LEGAL_COPY_APPROVED !== "true") {
  console.warn("[NWF] Privacy Policy page is still placeholder copy. Set LEGAL_COPY_APPROVED=true after attorney review.");
}

const LAST_UPDATED = "2026-06-13";

export default function PrivacyPolicy() {
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
        <h1>Privacy Policy</h1>
        <p className="legal-updated">Last updated: {LAST_UPDATED}</p>

        <div className="legal-notice" role="note">
          ⚠️ Draft / placeholder. This page exists so account sign-up can link to
          it; the content has not been reviewed by counsel and is not yet binding.
        </div>

        <h2>1. Information we collect</h2>
        <ul>
          <li>
            <strong>Account data</strong> — email, name, and OAuth profile
            details provided through Clerk and Google sign-in.
          </li>
          <li>
            <strong>Usage data</strong> — how you interact with briefings,
            signals, Hold/Fold, and the AI council.
          </li>
          <li>
            <strong>Data you input</strong> — any tickers, holdings, or prompts
            you submit to the tools.
          </li>
        </ul>

        <h2>2. Third-party processors</h2>
        <p>We share data with service providers strictly to operate the product:</p>
        <ul>
          <li><strong>Clerk</strong> — authentication and user management</li>
          <li><strong>Google</strong> — OAuth sign-in</li>
          <li><strong>Stripe</strong> — payment processing (paid features)</li>
          <li><strong>Vercel</strong> — hosting</li>
          <li>
            <strong>AI/LLM providers</strong> — prompts and context sent to power
            the AI council and analysis features
          </li>
        </ul>

        <h2>3. How AI features use your data</h2>
        <p>
          When you use AI features, your prompts and relevant context may be sent
          to model providers to generate responses. Do not submit information you
          are not comfortable sharing with those providers.
        </p>

        <h2>4. Data retention and deletion</h2>
        <p>
          We retain account data while your account is active. You may request
          deletion of your account and associated data by contacting us; account
          deletion removes your authentication record via Clerk.
        </p>

        <h2>5. Your rights (GDPR / CCPA)</h2>
        <p>
          Depending on your jurisdiction, you may have rights to access, correct,
          delete, or port your data, and to opt out of the “sale” or “sharing” of
          personal information. Contact us to exercise these rights.
        </p>

        <h2>6. Cookies</h2>
        <p>
          We use a session cookie (set on the nuwrrrld.com domain by Clerk) to
          keep you signed in, plus any cookies required by the processors above.
        </p>

        <h2>7. Contact</h2>
        <p>
          Privacy questions or data requests:{" "}
          <a className="inline" href="mailto:chillcoders@gmail.com">
            chillcoders@gmail.com
          </a>
          .
        </p>

        <p className="legal-footer">
          © {new Date().getFullYear()} NuWrrrld Financial. Placeholder policy —
          replace with counsel-reviewed copy before launch. See also our{" "}
          <Link className="inline" href="/terms-of-service">Terms of Service</Link>.
        </p>
      </main>
    </div>
  );
}
