export interface EvidenceReceipt {
  headSha?: string;
  preview?: { url?: string; headSha?: string };
  checks?: Array<{ name?: string; kind?: string; status?: string; claimed?: string }>;
  database?: { mode?: string; claimedReal?: boolean };
  ui?: { mode?: string; claimedProduction?: boolean };
  reviewer?: { claimedIndependent?: boolean; isAuthor?: boolean; identityAttestation?: { signature?: string; keyId?: string; trustAnchorUrl?: string } };
  runtime?: { claimedCause?: boolean; evidence?: string };
  sourceUrl?: string;
  completedAt?: string;
  checkedAt?: string;
  completionEvidence?: { sourceUrl?: string; observedAt?: string };
  schedule?: { usesExpectedTime?: boolean; sourceUrl?: string; sourceCheckedAt?: string };
  query?: { error?: unknown; claimedSuccess?: boolean };
  tasks?: Array<{ id?: string; checked?: boolean; evidence?: string }>;
  fileClaims?: Array<{ writer?: string; files?: string[] }>;
  provider?: { claimedFreeOnly?: boolean; mode?: string };
  connection?: { claimedOffline?: boolean; mode?: string };
  containsSecret?: boolean;
}
export function validateEvidenceReceipt(receipt: EvidenceReceipt | null | undefined): { valid: boolean; errors: string[] };
