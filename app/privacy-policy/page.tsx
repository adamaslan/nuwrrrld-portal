import Link from "next/link";
import type { Metadata } from "next";
import "../legal.css";

export const metadata: Metadata = {
  title: "Privacy Policy · NuWrrrld Financial",
  description: "How NuWrrrld Financial collects, uses, and protects your data.",
};

const LAST_UPDATED = "2026-06-28";

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

        <h2>1. Overview</h2>
        <p>
          NuWrrrld Financial ("we", "our", "Company") operates the NuWrrrld Financial
          website, mobile application, and services (the "Service"). This Privacy Policy
          explains how we collect, use, disclose, and safeguard your information when you
          access and use the Service.
        </p>
        <p>
          Please read this Privacy Policy carefully. If you do not agree with our policies
          and practices, please do not use the Service. By using the Service, you acknowledge
          that you have read and agree to this Privacy Policy.
        </p>

        <h2>2. Information we collect</h2>
        <p><strong>Account and authentication data:</strong></p>
        <ul>
          <li>Email address, name, and profile picture (from Clerk or Google OAuth)</li>
          <li>Password (if using email/password authentication)</li>
          <li>Phone number (if provided)</li>
        </ul>
        <p><strong>Usage and interaction data:</strong></p>
        <ul>
          <li>How you interact with the Service (briefings viewed, signals reviewed, tools used)</li>
          <li>Holdings, watchlists, and tickers you search or save</li>
          <li>Prompts and queries you submit to the AI Council</li>
          <li>Subscription tier and billing information</li>
        </ul>
        <p><strong>Device and browsing data:</strong></p>
        <ul>
          <li>IP address, browser type, operating system, device information</li>
          <li>Pages visited, time spent, referring URLs, and clickstream data</li>
          <li>Cookies and similar tracking identifiers</li>
        </ul>

        <h2>3. How we use your information</h2>
        <p>We use collected information for:</p>
        <ul>
          <li>Account creation, authentication, and account management</li>
          <li>Delivering and personalizing the Service</li>
          <li>Processing payments and managing subscriptions</li>
          <li>Communicating with you (support, updates, account notifications)</li>
          <li>Analytics and improving the Service (usage patterns, feature optimization)</li>
          <li>Fraud prevention and security</li>
          <li>Legal compliance and enforcing our Terms</li>
          <li>Marketing (if you opt in)</li>
        </ul>

        <h2>4. Third-party service providers and data sharing</h2>
        <p>
          We work with third-party service providers who may access your personal data to
          help us operate the Service. These providers are contractually bound to use your
          data only for the purposes we specify and to maintain confidentiality.
        </p>
        <p><strong>Service providers we use:</strong></p>
        <ul>
          <li>
            <strong>Clerk</strong> - authentication, user management, and session management.
            Clerk privacy policy governs how they use your authentication data.
          </li>
          <li>
            <strong>Google</strong> - OAuth sign-in. Google privacy policy governs OAuth data.
          </li>
          <li>
            <strong>Stripe</strong> - payment processing and subscription management. Stripe
            does not retain full payment card details; we never see raw card numbers.
          </li>
          <li>
            <strong>Vercel</strong> - hosting and CDN. Vercel may process limited data to
            serve the Service and manage logs.
          </li>
          <li>
            <strong>AI/LLM providers</strong> (e.g., OpenRouter, Anthropic) - When you use
            the AI Council or related features, your prompts and relevant context may be
            transmitted to third-party model providers to generate responses. Your data
            is processed according to each provider privacy policies.
          </li>
          <li>
            <strong>Analytics (if enabled)</strong> - We may use analytics tools to measure
            Service performance and user behavior.
          </li>
        </ul>

        <h2>5. AI feature data handling</h2>
        <p>
          When you use AI features (AI Council, signal analysis, Hold/Fold verdicts), your
          inputs (prompts, market data, holdings) and interaction context may be transmitted
          to third-party LLM providers to generate responses. <strong>We recommend that you
          do not submit sensitive personal information, passwords, or non-public information
          to AI features.</strong>
        </p>
        <p>
          By using AI features, you acknowledge that your data will be processed by
          third-party providers and is subject to their privacy policies and data handling
          practices.
        </p>

        <h2>6. Data retention</h2>
        <p>
          We retain your account data while your account is active and for a reasonable
          period afterward to comply with legal obligations, resolve disputes, and enforce
          agreements. You may request deletion of your account at any time; upon deletion,
          your data will be removed from active systems, subject to legal retention requirements.
        </p>

        <h2>7. Security</h2>
        <p>
          We implement appropriate technical, administrative, and physical safeguards to
          protect your information against unauthorized access, alteration, and loss.
          However, no security system is impenetrable. We are not responsible for
          unauthorized access or breaches beyond our reasonable control.
        </p>

        <h2>8. Your rights and choices</h2>
        <p><strong>Depending on your location, you may have the following rights:</strong></p>
        <ul>
          <li>
            <strong>Right to access:</strong> You may request a copy of the personal data
            we hold about you.
          </li>
          <li>
            <strong>Right to correct:</strong> You may request that we correct inaccurate data.
          </li>
          <li>
            <strong>Right to delete:</strong> You may request deletion of your data (the "right
            to be forgotten").
          </li>
          <li>
            <strong>Right to restrict processing:</strong> You may request that we limit how
            we use your data.
          </li>
          <li>
            <strong>Right to data portability:</strong> You may request your data in a
            structured, machine-readable format.
          </li>
          <li>
            <strong>Right to opt out of marketing:</strong> You may opt out of promotional
            communications at any time.
          </li>
          <li>
            <strong>GDPR and CCPA rights:</strong> If you are in the EU or California, you have
            additional rights under GDPR and CCPA/CPRA. Contact us to exercise these rights.
          </li>
        </ul>
        <p>
          To exercise any of these rights, contact us at{" "}
          <a className="inline" href="mailto:chillcoders@gmail.com">
            chillcoders@gmail.com
          </a>.
        </p>

        <h2>9. Cookies and tracking</h2>
        <p>
          The Service uses cookies and similar tracking technologies to:
        </p>
        <ul>
          <li>Maintain your session and keep you signed in (session cookies from Clerk)</li>
          <li>Remember preferences and settings</li>
          <li>Perform analytics (if enabled)</li>
        </ul>
        <p>
          You can control cookies through your browser settings. Disabling cookies may
          affect Service functionality.
        </p>

        <h2>10. Childrens privacy</h2>
        <p>
          The Service is intended for users 18 years of age and older. We do not knowingly
          collect personal data from individuals under 18. If we become aware that we have
          collected data from a minor, we will take steps to delete such data and terminate
          the minors account.
        </p>

        <h2>11. International data transfers</h2>
        <p>
          Your information may be transferred to, stored in, and processed in countries other
          than your country of residence, which may have data protection laws that differ
          from your home country. By using the Service, you consent to the transfer of your
          information to countries outside your country of residence.
        </p>

        <h2>12. Changes to this Privacy Policy</h2>
        <p>
          We may update this Privacy Policy at any time. Material changes will be noted by
          updating the "Last updated" date above. Your continued use of the Service after
          changes constitutes your acceptance. If you do not agree to the updated policy,
          you must discontinue use of the Service.
        </p>

        <h2>13. Contact us</h2>
        <p>
          For privacy questions, data requests, or to exercise your rights:
        </p>
        <p>
          <a className="inline" href="mailto:chillcoders@gmail.com">
            chillcoders@gmail.com
          </a>
        </p>
        <p>
          See also our{" "}
          <Link className="inline" href="/terms-of-service">Terms of Service</Link>.
        </p>

        <p className="legal-footer">
          © {new Date().getFullYear()} NuWrrrld Financial. All rights reserved.
        </p>
      </main>
    </div>
  );
}
