import { createHash } from "node:crypto";

/**
 * Build a repeat-safe provider key for one recipient, message kind, and UTC day.
 * Recipient addresses are normalized before hashing so they never appear in
 * provider headers or logs as part of the key.
 */
export function emailIdempotencyKey(
  recipient: string,
  messageKind: string,
  date = new Date(),
): string {
  const day = date.toISOString().slice(0, 10);
  const identity = JSON.stringify([recipient.trim().toLowerCase(), messageKind, day]);
  return `email_${createHash("sha256").update(identity).digest("hex")}`;
}
