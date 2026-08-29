/**
 * Server read helpers for consent state. Nothing here does I/O to the database;
 * persistence lives in lib/consent-db.ts (signed-in, Neon) and the nu_consent
 * first-party cookie (client + server read).
 *
 * GPC/DNT signal detection and application happens here; a Global Privacy
 * Control or Do Not Track header always wins over the stored cookie value.
 */

import { cookies } from "next/headers";
import type { NextRequest } from "next/server";

import {
  CONSENT_COOKIE,
  parseConsent,
  applyDoNotTrack,
  type ConsentRecord,
} from "@/lib/shared/consent";

export async function getConsent(): Promise<ConsentRecord | null> {
  const c = await cookies();
  return parseConsent(c.get(CONSENT_COOKIE)?.value);
}

export function readConsentFromRequest(req: NextRequest): ConsentRecord | null {
  return parseConsent(req.cookies.get(CONSENT_COOKIE)?.value);
}

export function detectDoNotTrack(headers: Headers): "gpc" | "dnt" | null {
  if (headers.get("sec-gpc") === "1") return "gpc";
  if (headers.get("dnt") === "1") return "dnt";
  return null;
}

/** A GPC/DNT header always wins over the stored cookie value. */
export function resolveConsent(
  record: ConsentRecord | null,
  headers: Headers,
): ConsentRecord | null {
  const dnt = detectDoNotTrack(headers);
  if (dnt) return applyDoNotTrack(record, dnt);
  return record;
}
