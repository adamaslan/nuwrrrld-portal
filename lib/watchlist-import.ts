/**
 * Watchlist CSV import — pure validation, no I/O except the capped body reader.
 *
 * The browser extracts tickers from the CSV and posts a JSON array; the server
 * never sees a file. Everything here treats that array as hostile input. See
 * docs/watchlist-csv-upload-plan.md for the threat model.
 */
import { normalizeTicker, isCryptoShaped } from "@/lib/shared/signal-policy";

export const MAX_IMPORT_BODY_BYTES = 32_768;
export const MAX_IMPORT_ROWS = 500;
export const MAX_WATCHLIST_SIZE = 1_500;
export const MAX_RAW_TICKER_LENGTH = 16;
export const IMPORT_RATE_LIMIT = 5;
export const IMPORT_RATE_WINDOW_MS = 60 * 60_000;
export const MAX_REJECTED_SAMPLE = 20;

export type RejectReason = "invalid" | "crypto_unsupported" | "unknown_symbol" | "already_present";

export class ImportHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export interface ParsedImportBody {
  tickers: string[];
  dryRun: boolean;
}

/** Validate the request JSON's shape. Throws ImportHttpError; never partially accepts. */
export function parseImportBody(body: unknown): ParsedImportBody {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ImportHttpError(400, "invalid_body");
  }
  const { tickers, dryRun } = body as Record<string, unknown>;
  if (!Array.isArray(tickers)) throw new ImportHttpError(400, "tickers_must_be_array");
  if (tickers.length > MAX_IMPORT_ROWS) throw new ImportHttpError(413, "too_many_rows");
  if (dryRun !== undefined && typeof dryRun !== "boolean") {
    throw new ImportHttpError(400, "invalid_dry_run");
  }
  for (const t of tickers) {
    if (typeof t !== "string" || t.length > MAX_RAW_TICKER_LENGTH) {
      throw new ImportHttpError(400, "invalid_ticker_entry");
    }
  }
  return { tickers: tickers as string[], dryRun: dryRun === true };
}

export interface FormatPass {
  /** Deduped, format-valid, non-crypto symbols. */
  candidates: string[];
  invalid: number;
  cryptoUnsupported: number;
}

/** Regex/crypto pass. Rejected raw values are counted, never returned. */
export function classifyFormat(raw: readonly string[]): FormatPass {
  const seen = new Set<string>();
  let invalid = 0;
  let cryptoUnsupported = 0;
  for (const value of raw) {
    const t = normalizeTicker(value);
    if (!t) {
      invalid += 1;
      continue;
    }
    if (isCryptoShaped(t)) {
      cryptoUnsupported += 1;
      continue;
    }
    seen.add(t);
  }
  return { candidates: [...seen], invalid, cryptoUnsupported };
}

/** Symbols to look up in the universe: the symbol itself plus its dotted form (BRK-B → BRK.B). */
export function universeLookupKeys(candidates: readonly string[]): string[] {
  const keys = new Set<string>();
  for (const c of candidates) {
    keys.add(c);
    if (c.includes("-")) keys.add(c.replace(/-/g, "."));
  }
  return [...keys];
}

export interface UniverseResolution {
  accepted: string[];
  unknown: string[];
}

/**
 * Map each candidate onto a universe symbol. A hyphenated symbol is only
 * rewritten to its dotted form when that exact form is in the universe.
 */
export function resolveAgainstUniverse(
  candidates: readonly string[],
  universe: ReadonlySet<string>,
): UniverseResolution {
  const accepted = new Set<string>();
  const unknown: string[] = [];
  for (const c of candidates) {
    if (universe.has(c)) {
      accepted.add(c);
      continue;
    }
    const dotted = c.replace(/-/g, ".");
    if (dotted !== c && universe.has(dotted)) accepted.add(dotted);
    else unknown.push(c);
  }
  return { accepted: [...accepted], unknown };
}

/**
 * Origin / CSRF gate. Returns an error code to reject with 403, or null.
 * `allowedOrigins` is the exact-match allow-list; a request with no Origin
 * header (same-origin GET-less tools, curl) is judged by Sec-Fetch-Site alone.
 */
export function checkRequestOrigin(
  headers: Pick<Headers, "get">,
  allowedOrigins: readonly string[],
): string | null {
  if (headers.get("sec-fetch-site") === "cross-site") return "cross_site";
  const origin = headers.get("origin");
  if (origin !== null && !allowedOrigins.includes(origin)) return "origin_not_allowed";
  return null;
}

export function allowedOriginsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const origins: string[] = [];
  const app = env.NEXT_PUBLIC_APP_URL;
  if (app) {
    try {
      origins.push(new URL(app).origin);
    } catch {
      /* malformed env — fail closed to the empty list */
    }
  }
  if (env.NODE_ENV !== "production") origins.push("http://localhost:3000");
  return origins;
}

export function isJsonContentType(headers: Pick<Headers, "get">): boolean {
  const ct = headers.get("content-type");
  return ct !== null && ct.split(";")[0].trim().toLowerCase() === "application/json";
}

/**
 * Read the request body as JSON, aborting once `maxBytes` is exceeded.
 * Content-Length is advisory only and never trusted.
 */
export async function readJsonCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number = MAX_IMPORT_BODY_BYTES,
): Promise<unknown> {
  if (!body) throw new ImportHttpError(400, "empty_body");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ImportHttpError(413, "body_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ImportHttpError(400, "invalid_json");
  }
}
