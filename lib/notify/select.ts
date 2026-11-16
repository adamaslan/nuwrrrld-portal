import { createBrevoProvider } from "./brevo";
import { createResendProvider, type EmailProvider } from "./email";

/**
 * Explicit provider selection. Default (unset) is Resend. Choosing "brevo"
 * without BREVO_API_KEY throws; there is no silent fallback to another
 * provider and no automatic failover. Not wired into any route yet.
 */
export function selectEmailProvider(env: Readonly<Record<string, string | undefined>>): EmailProvider {
  const which = (env.ALERT_EMAIL_PROVIDER ?? "resend").toLowerCase();
  if (which === "resend") {
    if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY not set");
    return createResendProvider(env.RESEND_API_KEY);
  }
  if (which === "brevo") {
    if (!env.BREVO_API_KEY) throw new Error("BREVO_API_KEY not set");
    return createBrevoProvider(env.BREVO_API_KEY);
  }
  throw new Error(`Unsupported ALERT_EMAIL_PROVIDER: ${which}`);
}
