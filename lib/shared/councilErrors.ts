/**
 * councilErrors — user-facing messages for /api/council failure codes.
 * Shared by every client of that route so a new error code renders the same
 * sentence everywhere instead of falling through to a bare HTTP status.
 */
export const COUNCIL_ERROR_MESSAGES: Record<string, string> = {
  council_response_invalid:
    "The council's response didn't come back in a usable format — please try again.",
  upgrade_required: "Upgrade to Pro to consult the AI council.",
  unauthenticated: "Sign in to consult the AI council.",
};

/** Resolve an error payload + status into a sentence safe to show a user. */
export function councilErrorMessage(code: unknown, status: number): string {
  return (
    (typeof code === "string" ? COUNCIL_ERROR_MESSAGES[code] : undefined) ??
    `Council unavailable (HTTP ${status}).`
  );
}
