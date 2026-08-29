/**
 * legal-consent — the versioned identifiers for express consent to the Terms of
 * Service and Privacy Policy, captured at sign-up (Phase 1.4 of
 * docs/todo-auth-cookies-tracking.md). Pure: no I/O.
 *
 * Bump the version string for a document when a change is *material* enough to
 * require re-consent. A stored event references the version it accepted, so old
 * records stay valid evidence of what the user actually agreed to.
 *
 * Mirrored in gcp3-mobile so a checkbox on either surface satisfies both.
 */

export const TOS_VERSION = "2026-08-29";
export const PRIVACY_VERSION = "2026-08-29";

export const TOS_URL = "https://nuwrrrld.com/terms-of-service";
export const PRIVACY_URL = "https://nuwrrrld.com/privacy-policy";

export type LegalDoc = "tos" | "privacy";

export const LEGAL_DOC_VERSIONS: Record<LegalDoc, string> = {
  tos: TOS_VERSION,
  privacy: PRIVACY_VERSION,
};

/** The two events a fresh sign-up must produce, in the shape the API expects. */
export function requiredConsentEvents(): Array<{ doc: LegalDoc; version: string }> {
  return [
    { doc: "tos", version: TOS_VERSION },
    { doc: "privacy", version: PRIVACY_VERSION },
  ];
}
