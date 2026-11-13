/** Return a failure message when live extraction left chunks unprocessed. */
export function extractionFailureMessage({ dryRun, callsMade, extractFailures }) {
  if (dryRun || extractFailures === 0) return null;

  const failedCalls = extractFailures === callsMade
    ? `all ${callsMade} extraction calls failed`
    : `${extractFailures} of ${callsMade} extraction calls failed`;

  return `${failedCalls}; failed chunks were not persisted and existing rows were left intact`;
}
