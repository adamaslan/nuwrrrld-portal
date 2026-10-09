/**
 * Pure helpers behind the nulogdash "Beta testers" panel: validate the admin's
 * input and build the `publicMetadata.beta` object that lib/beta-grant.ts reads.
 * No Clerk, no I/O — the Server Actions (lib/nulogdash-beta-actions.ts) own those.
 */
import { hasActiveBetaGrant } from './beta-grant';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_NOTE_LENGTH = 200;

export interface GrantInput {
  email: string;
  /** `YYYY-MM-DD` or empty for no expiry. */
  expiresAt: string;
  note: string;
}

export interface ParsedGrantInput {
  email: string;
  expiresAt: string | null;
  note: string | null;
}

export type ParseGrantResult = ({ ok: true } & ParsedGrantInput) | { ok: false; error: string };

export interface BetaGrant {
  tier: 'pro';
  grantedAt: string;
  expiresAt: string | null;
  grantedBy: 'admin';
  note?: string;
}

export interface BetaGrantSummary {
  userId: string;
  email: string;
  active: boolean;
  grantedAt: string | null;
  expiresAt: string | null;
  note: string | null;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isRealCalendarDate(value: string): boolean {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Validates the panel's form fields. `now` is injectable for tests. */
export function parseGrantInput(raw: GrantInput, now: Date = new Date()): ParseGrantResult {
  const email = (raw?.email ?? '').trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) return { ok: false, error: 'Enter a valid email address.' };

  const expiresRaw = (raw?.expiresAt ?? '').trim();
  let expiresAt: string | null = null;
  if (expiresRaw) {
    if (!isRealCalendarDate(expiresRaw)) {
      return { ok: false, error: 'Expiry must be a real date in YYYY-MM-DD form.' };
    }
    // A grant is active until the start of its expiry day (UTC), so today's
    // date would already be expired.
    if (expiresRaw <= isoDay(now)) return { ok: false, error: 'Expiry must be a future date.' };
    expiresAt = expiresRaw;
  }

  const note = (raw?.note ?? '').trim();
  if (note.length > MAX_NOTE_LENGTH) {
    return { ok: false, error: `Note must be ${MAX_NOTE_LENGTH} characters or fewer.` };
  }

  return { ok: true, email, expiresAt, note: note || null };
}

/** The exact object written to `publicMetadata.beta`. */
export function buildBetaGrant(input: ParsedGrantInput, now: Date = new Date()): BetaGrant {
  return {
    tier: 'pro',
    grantedAt: isoDay(now),
    expiresAt: input.expiresAt,
    grantedBy: 'admin',
    ...(input.note ? { note: input.note } : {}),
  };
}

/**
 * Reads a user's `publicMetadata.beta` for display. Returns null when the user
 * has no grant at all; `active` reuses hasActiveBetaGrant so the panel can never
 * disagree with what resolveTier() actually does.
 */
export function summarizeBetaGrant(
  userId: string,
  email: string,
  publicMetadata: Record<string, unknown> | null | undefined,
  now: Date = new Date(),
): BetaGrantSummary | null {
  const beta = publicMetadata?.beta;
  if (typeof beta !== 'object' || beta === null) return null;

  const { grantedAt, expiresAt, note } = beta as Record<string, unknown>;
  return {
    userId,
    email,
    active: hasActiveBetaGrant(publicMetadata, now),
    grantedAt: typeof grantedAt === 'string' ? grantedAt : null,
    expiresAt: typeof expiresAt === 'string' ? expiresAt : null,
    note: typeof note === 'string' && note ? note : null,
  };
}
