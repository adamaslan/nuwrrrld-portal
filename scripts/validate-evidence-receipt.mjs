/** Offline guard for evidence claims. It validates claims only; it never
 * probes a repository, database, provider, deployment, or reviewer identity.
 * Structural validity is not proof that a supplied signature or evidence is true. */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export function validateEvidenceReceipt(receipt) {
  const errors = [];
  const reject = (code) => errors.push(code);
  if (!receipt || typeof receipt !== "object") return { valid: false, errors: ["receipt.invalid"] };

  if (!/^[0-9a-f]{40}$/i.test(receipt.headSha ?? "")) reject("head.missing-or-ambiguous");
  if (receipt.preview && receipt.preview.headSha !== receipt.headSha) reject("preview.head-mismatch");
  if (receipt.preview && !/^https:\/\//i.test(receipt.preview.url ?? "")) reject("preview.url-invalid");
  for (const check of receipt.checks ?? []) {
    if (check.status === "skipped" && check.claimed === "passed") reject("check.skipped-claimed-passed");
    if (check.name === "full-build" && check.kind === "typecheck") reject("build.typecheck-mislabeled");
  }
  if (receipt.database?.claimedReal && receipt.database?.mode !== "real") reject("database.mock-claimed-real");
  if (receipt.ui?.claimedProduction && receipt.ui?.mode !== "production") reject("ui.synthetic-claimed-production");
  const attestation = receipt.reviewer?.identityAttestation;
  if (receipt.reviewer?.claimedIndependent && !(attestation?.signature && attestation?.keyId && /^https:\/\//i.test(attestation?.trustAnchorUrl ?? ""))) reject("reviewer.identity-unverified");
  if (receipt.reviewer?.claimedIndependent && receipt.reviewer?.isAuthor) reject("reviewer.is-author");
  if (receipt.runtime?.claimedCause && receipt.runtime?.evidence !== "runtime") reject("runtime.fixture-claimed-cause");
  if (!/^https:\/\//i.test(receipt.sourceUrl ?? "")) reject("source.url-missing");
  if (receipt.completedAt && (!receipt.completionEvidence?.sourceUrl || receipt.completionEvidence.observedAt !== receipt.completedAt)) reject("completion.timestamp-unsubstantiated");
  if (receipt.schedule?.usesExpectedTime && (!receipt.schedule?.sourceUrl || receipt.schedule.sourceCheckedAt !== receipt.checkedAt)) reject("schedule.expected-time-unsupported");
  if (receipt.query?.error && receipt.query?.claimedSuccess) reject("query.error-claimed-success");

  const ids = (receipt.tasks ?? []).map((task) => task.id);
  if (new Set(ids).size !== ids.length) reject("task.duplicate-id");
  const fileOwners = new Map();
  for (const claim of receipt.fileClaims ?? []) for (const file of claim.files ?? []) {
    if (fileOwners.has(file) && fileOwners.get(file) !== claim.writer) reject("files.multiple-writers");
    fileOwners.set(file, claim.writer);
  }
  if (receipt.provider?.claimedFreeOnly && receipt.provider?.mode === "paid") reject("provider.paid-under-free-only");
  if (receipt.connection?.claimedOffline && receipt.connection?.mode === "live") reject("connection.live-under-offline");
  if (receipt.containsSecret === true || containsSecretLikeValue(receipt)) reject("receipt.contains-secret");
  if ((receipt.tasks ?? []).some((task) => task.checked && !task.evidence)) reject("task.checked-without-evidence");
  return { valid: errors.length === 0, errors };
}

function containsSecretLikeValue(value, key = "") {
  if (typeof value === "string") {
    if (/(secret|password|api[_-]?key|access[_-]?token)/i.test(key) && value.trim() && !/^(redacted|placeholder|example|test)$/i.test(value.trim())) return true;
    return /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----|\bAKIA[A-Z0-9]{16}\b|\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b|\bsk-[A-Za-z0-9_-]{20,}\b|\bBearer\s+[A-Za-z0-9._~+/-]{24,}|\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*[^\s<>{},]{8,}/i.test(value);
  }
  if (Array.isArray(value)) return value.some((item) => containsSecretLikeValue(item));
  if (value && typeof value === "object") return Object.entries(value).some(([childKey, child]) => containsSecretLikeValue(child, childKey));
  return false;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const input = process.argv[2] ? await readFile(process.argv[2], "utf8") : await readStdin();
    const result = validateEvidenceReceipt(JSON.parse(input));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.valid) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`Invalid receipt input: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 2;
  }
}

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}
