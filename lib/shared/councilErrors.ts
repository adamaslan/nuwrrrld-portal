/**
 * councilErrors — user-facing messages for /api/council failure codes.
 * Shared by every client of that route so a new error code renders the same
 * sentence everywhere instead of falling through to a bare HTTP status.
 */
export const COUNCIL_ERROR_MESSAGES: Record<string, string> = {
  council_no_content: "The AI providers returned no usable council answer. Existing signal data is unchanged; retrying may still fail.",
  council_provider_unavailable: "The council's AI providers are unavailable. Existing signal data is unchanged.",
  council_not_configured: "Council access is not configured on this environment. Retrying will not fix it.",
  council_response_invalid:
    "The council's response didn't come back in a usable format — please try again.",
  upgrade_required: "Upgrade to Pro to consult the AI council.",
  unauthenticated: "Sign in to consult the AI council.",
};

/**
 * Resolve an error payload + status into a sentence safe to show a user.
 * `code` comes off a parsed JSON body, so it can be any inherited key
 * (`toString`, `constructor`, `__proto__`) — an own-property check keeps a
 * function or object from reaching the UI where a string is expected.
 */
export function councilErrorMessage(code: unknown, status: number): string {
  const known =
    typeof code === "string" &&
    Object.prototype.hasOwnProperty.call(COUNCIL_ERROR_MESSAGES, code)
      ? COUNCIL_ERROR_MESSAGES[code]
      : undefined;
  return known ?? `Council unavailable (HTTP ${status}).`;
}
