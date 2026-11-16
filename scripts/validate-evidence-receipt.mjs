/** Offline guard for evidence claims. It validates claims only; it never
 * probes a repository, database, provider, deployment, or reviewer identity.
 * Structural validity is not proof that a supplied signature or evidence is true. */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export function validateEvidenceReceipt(receipt) {
  const errors = [];
  const reject = (code) => errors.push(code);
  // Accept partial receipts, but never coerce malformed supplied fields into
  // valid evidence. This is a JSON-shape check, not claim authentication.
  if (!isRecord(receipt)) return { valid: false, errors: ["receipt.invalid"] };
  if (!boundedJson(receipt)) return { valid: false, errors: ["receipt.structure-invalid"] };
  validateShape(receipt, RECEIPT_SHAPE, "schema", reject);
  if (errors.length) return { valid: false, errors };

  if (!/^[0-9a-f]{40}$/i.test(receipt.headSha ?? "")) reject("head.missing-or-ambiguous");
  if (receipt.preview && receipt.preview.headSha !== receipt.headSha) reject("preview.head-mismatch");
  if (receipt.preview && !isHttpsUrl(receipt.preview.url)) reject("preview.url-invalid");
  for (const check of receipt.checks ?? []) {
    if (check.status === "skipped" && check.claimed === "passed") reject("check.skipped-claimed-passed");
    if (check.claimed === "passed" && check.status !== "passed") reject("check.nonpass-claimed-passed");
    if (check.name === "full-build" && check.kind === "typecheck") reject("build.typecheck-mislabeled");
  }
  if (receipt.database?.claimedReal && receipt.database?.mode !== "real") reject("database.mock-claimed-real");
  if (receipt.ui?.claimedProduction && receipt.ui?.mode !== "production") reject("ui.synthetic-claimed-production");
  const attestation = receipt.reviewer?.identityAttestation;
  if (receipt.reviewer?.claimedIndependent && !(attestation?.signature && attestation?.keyId && isHttpsUrl(attestation?.trustAnchorUrl))) reject("reviewer.identity-unverified");
  if (receipt.reviewer?.claimedIndependent && receipt.reviewer?.isAuthor) reject("reviewer.is-author");
  if (receipt.runtime?.claimedCause && receipt.runtime?.evidence !== "runtime") reject("runtime.fixture-claimed-cause");
  if (!isHttpsUrl(receipt.sourceUrl)) reject("source.url-missing");
  if (receipt.completedAt && (!receipt.completionEvidence?.sourceUrl || receipt.completionEvidence.observedAt !== receipt.completedAt)) reject("completion.timestamp-unsubstantiated");
  if (receipt.schedule?.usesExpectedTime && (!receipt.schedule?.sourceUrl || receipt.schedule.sourceCheckedAt !== receipt.checkedAt)) reject("schedule.expected-time-unsupported");
  if (receipt.query?.error && receipt.query?.claimedSuccess) reject("query.error-claimed-success");

  for (const [label, value] of [
    ["attestation", attestation?.trustAnchorUrl],
    ["completion", receipt.completionEvidence?.sourceUrl],
    ["schedule", receipt.schedule?.sourceUrl],
  ]) if (value !== undefined && !isHttpsUrl(value)) reject(`${label}.url-invalid`);
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


// Optional fields retain their existing partial-receipt semantics. If present,
// their containers and values must match the declaration before claim checks.
const RECEIPT_SHAPE = {
  headSha: "string", sourceUrl: "string", completedAt: "string", checkedAt: "string",
  preview: { url: "string", headSha: "string" },
  checks: [{ name: "string", kind: "string", status: "string", claimed: "string" }],
  tasks: [{ id: "string", checked: "boolean", evidence: "string" }],
  fileClaims: [{ writer: "string", files: ["string"] }],
  database: { mode: "string", claimedReal: "boolean" },
  ui: { mode: "string", claimedProduction: "boolean" },
  reviewer: { claimedIndependent: "boolean", isAuthor: "boolean",
    identityAttestation: { signature: "string", keyId: "string", trustAnchorUrl: "string" } },
  runtime: { claimedCause: "boolean", evidence: "string" },
  completionEvidence: { sourceUrl: "string", observedAt: "string" },
  schedule: { usesExpectedTime: "boolean", sourceUrl: "string", sourceCheckedAt: "string" },
  query: { claimedSuccess: "boolean" },
  provider: { claimedFreeOnly: "boolean", mode: "string" },
  connection: { claimedOffline: "boolean", mode: "string" },
  containsSecret: "boolean", secret: "string",
};

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validateShape(value, shape, path, reject) {
  if (typeof shape === "string") {
    if (typeof value !== shape) reject(path);
  } else if (Array.isArray(shape)) {
    if (!Array.isArray(value)) { reject(path); return; }
    value.forEach((item, index) => validateShape(item, shape[0], `${path}.${index}`, reject));
  } else {
    if (!isRecord(value)) { reject(path); return; }
    for (const [key, childShape] of Object.entries(shape)) {
      if (Object.hasOwn(value, key) && value[key] !== undefined) validateShape(value[key], childShape, `${path}.${key}`, reject);
    }
  }
}
function isHttpsUrl(value) {
  if (typeof value !== "string" || !/^https:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !!url.hostname && !url.username && !url.password;
  } catch { return false; }
}
function boundedJson(value, depth = 0, seen = new Set(), budget = { left: 10_000 }) {
  if (--budget.left < 0 || depth > 40) return false;
  if (value == null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  const ok = Object.values(value).every(child => boundedJson(child, depth + 1, seen, budget));
  seen.delete(value);
  return ok;
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
