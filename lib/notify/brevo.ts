/**
 * Brevo (transactional email) provider. INERT: nothing imports this yet and it
 * needs a BREVO_API_KEY that is not set anywhere. Endpoint and fields per
 * https://developers.brevo.com/reference/send-transac-email
 *
 * Idempotency: the single-send endpoint documents no idempotency key (only the
 * batch endpoint does), so supportsIdempotencyKey is false and a passed key is
 * rejected rather than silently ignored. Callers must not retry or fail over
 * onto Brevo after an ambiguous failure.
 */
import type { EmailMessage, EmailProvider, EmailSendOptions, EmailSendResult } from "./email";

export const BREVO_EMAILS_URL = "https://api.brevo.com/v3/smtp/email";

/** "Name <a@b.test>" or "a@b.test" -> Brevo sender object. Name max 70 chars. */
export function parseSender(from: string): { email: string; name?: string } {
  const m = /^\s*(.*?)\s*<([^<>]+)>\s*$/.exec(from);
  if (!m) return { email: from.trim() };
  const name = m[1].replace(/^"|"$/g, "").slice(0, 70);
  return name ? { email: m[2].trim(), name } : { email: m[2].trim() };
}

export function createBrevoProvider(apiKey: string): EmailProvider {
  return {
    name: "brevo",
    supportsIdempotencyKey: false,
    async send(message: EmailMessage, options: EmailSendOptions = {}): Promise<EmailSendResult> {
      if (options.idempotencyKey) {
        throw new Error("Brevo single-send has no documented idempotency key; refusing to pretend dedup");
      }
      const init: RequestInit = {
        method: "POST",
        headers: { "api-key": apiKey, "Content-Type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          sender: parseSender(message.from),
          to: message.to.map(email => ({ email })),
          subject: message.subject,
          htmlContent: message.html,
        }),
      };
      if (options.timeoutMs !== undefined) init.signal = AbortSignal.timeout(options.timeoutMs);
      const res = await fetch(BREVO_EMAILS_URL, init);
      return { ok: res.ok, status: res.status, errorText: () => res.text() };
    },
  };
}
