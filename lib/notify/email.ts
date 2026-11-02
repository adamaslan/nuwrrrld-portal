/**
 * Email provider seam. Step 1 only: a thin wrapper around the exact Resend
 * request the routes already made inline. No retries, no failover, no
 * idempotency key unless a caller passes one explicitly (none do today).
 *
 * Network errors (timeout, DNS) are NOT caught here: each route keeps its own
 * existing handling, so route behavior is unchanged.
 */

export interface EmailMessage {
  from: string;
  to: string[];
  subject: string;
  html: string;
}

export interface EmailSendOptions {
  /** Per-request abort bound. Omit for no bound (digest-email today). */
  timeoutMs?: number;
  /**
   * Optional provider idempotency key. Not passed by any route in this step.
   * Provider-side dedup is time-limited (Resend: 24h) and is not a durable
   * guarantee; callers must not treat it as one.
   */
  idempotencyKey?: string;
}

export interface EmailSendResult {
  ok: boolean;
  status: number;
  /** Provider error body for logging; only call when ok is false. */
  errorText(): Promise<string>;
}

export interface EmailProvider {
  readonly name: "resend" | "brevo";
  /** True only where the provider documents an idempotency key for this send path. */
  readonly supportsIdempotencyKey: boolean;
  send(message: EmailMessage, options?: EmailSendOptions): Promise<EmailSendResult>;
}

export const RESEND_EMAILS_URL = "https://api.resend.com/emails";

export function createResendProvider(apiKey: string): EmailProvider {
  return {
    name: "resend",
    supportsIdempotencyKey: true,
    async send(message, options = {}) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      };
      if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
      const init: RequestInit = {
        method: "POST",
        headers,
        body: JSON.stringify({
          from: message.from,
          to: message.to,
          subject: message.subject,
          html: message.html,
        }),
      };
      if (options.timeoutMs !== undefined) init.signal = AbortSignal.timeout(options.timeoutMs);
      const res = await fetch(RESEND_EMAILS_URL, init);
      return { ok: res.ok, status: res.status, errorText: () => res.text() };
    },
  };
}
