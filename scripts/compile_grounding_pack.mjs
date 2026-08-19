#!/usr/bin/env node
/**
 * compile_grounding_pack — the one place a model reads the corpus
 * (docs/ai-council-timeline.html, PR 2 — "Compiler").
 *
 * Walks corpus/**\/*.md, chunks each file with grounding-chunker.mjs,
 * upserts corpus_chunks, then extracts per-chunk rule tuples via a single
 * batched LLM call each and upserts them into grounding_pack — keyed on
 * lib/grounding/taxonomy.ts's state-key space. A rule can only enter the
 * pack if its `quote` is a verbatim substring of the chunk body: the
 * pack physically cannot contain text the corpus doesn't.
 *
 * Zero extra deps beyond @neondatabase/serverless (already installed) —
 * same "plain Node ESM, native fetch" philosophy as refresh-free-models.mjs.
 * Runs the same on GitHub Actions or locally.
 *
 * Env / flags:
 *   DATABASE_URL          required
 *   OPENROUTER_API_KEY    required (unless --dry-run)
 *   CORPUS_VERSION        stamped on every row (default: git short SHA, else "dev")
 *   COMPILE_MODEL         model used for extraction (default: a free-tier model)
 *   --dry-run             chunk + extract, print counts, write nothing
 *
 * Exit codes: 0 = success, 1 = misconfigured / fatal error.
 */
import { readFile, readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { neon } from "@neondatabase/serverless";
import { chunkDocument, traderFilterForFile } from "./grounding-chunker.mjs";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(scriptDir, "..");
const CORPUS_DIR = join(repoRoot, "corpus");

const TAXONOMY_VERSION = "TAXONOMY_V1";
const OR_BASE = "https://openrouter.ai/api/v1";
const EXTRACT_TIMEOUT_MS = 30_000;

/**
 * Free model IDs churn — OpenRouter retires them without notice, and a
 * hardcoded default silently 404s every extraction while still exiting 0
 * ("chunks=2 rules_extracted=0" reads like an empty corpus, not a dead model).
 * `scripts/refresh-free-models.mjs` already maintains a live-probed chain in
 * lib/openrouter.ts; read the head of it rather than keeping a second, staler
 * copy here. Parsed from source because this is plain-Node ESM with no TS
 * loader — the same reason refresh-free-models.mjs rewrites that file textually.
 */
function firstFreeModelFromChain() {
  try {
    const src = readFileSync(join(repoRoot, "lib/openrouter.ts"), "utf8");
    const block = /export const FREE_MODEL_CHAIN\s*=\s*\[([\s\S]*?)\]/.exec(src)?.[1];
    return block ? /['"]([^'"]+)['"]/.exec(block)?.[1] ?? null : null;
  } catch {
    return null;
  }
}

const COMPILE_MODEL = process.env.COMPILE_MODEL ?? firstFreeModelFromChain();
const MAX_EXPANDED_ROWS_PER_RULE = 24; // guards against a Cartesian blow-up on under-constrained rules
const DRY_RUN = process.argv.includes("--dry-run");

/** Chunks whose extraction call never returned usable JSON (429, 5xx, timeout).
 *  Tracked so "the corpus yielded no rules" can be told apart from "the model
 *  was never successfully reached" — those look identical in the totals. */
let extractFailures = 0;

const RSI = ["oversold", "neutral", "overbought"];
const MACD = ["bullish_cross", "bearish_cross", "none"];
const ADX = ["trending", "ranging"];
const VOL = ["low", "normal", "high"];
const CONFLUENCE = ["weak", "moderate", "strong"];
const DIRECTIONS = ["bullish", "bearish", "neutral"];
const HORIZONS = ["t1", "t2"];

// A rule that leaves a dimension unconstrained ("any") defaults to this
// baseline bucket rather than expanding across every value — keeps a
// single extracted rule from fanning out into hundreds of pack rows.
const BASELINE = { rsi: "neutral", macd: "none", adx: "ranging", vol: "normal", confluence: "moderate" };

function corpusVersion() {
  if (process.env.CORPUS_VERSION) return process.env.CORPUS_VERSION;
  try {
    return execSync("git rev-parse --short HEAD", { cwd: repoRoot }).toString().trim();
  } catch {
    return "dev";
  }
}

async function walkMarkdown(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkMarkdown(full)));
    } else if (extname(entry.name) === ".md" && entry.name.toLowerCase() !== "readme.md") {
      files.push(full);
    }
  }
  return files;
}

function buildStateKey(parts) {
  return `rsi:${parts.rsi}|macd:${parts.macd}|adx:${parts.adx}|vol:${parts.vol}|confluence:${parts.confluence}|dir:${parts.direction}|h:${parts.horizon}`;
}

/** "any" stays as the single baseline value; an explicit array expands (capped). */
function valuesFor(field, vocab) {
  if (field === undefined || field === null || field === "any") return [BASELINE[fieldToBaselineKey(vocab)]];
  return Array.isArray(field) ? field : [field];
}

function fieldToBaselineKey(vocab) {
  if (vocab === RSI) return "rsi";
  if (vocab === MACD) return "macd";
  if (vocab === ADX) return "adx";
  if (vocab === VOL) return "vol";
  if (vocab === CONFLUENCE) return "confluence";
  throw new Error("no baseline for this vocab");
}

/**
 * Expand one extracted rule (with possible "any"/array fields) into concrete
 * `{ stateKey, horizon }` pairs — horizon carried alongside instead of being
 * re-parsed back out of the key string.
 */
function expandRule(rule) {
  const horizons = rule.horizon === "both" ? HORIZONS : [rule.horizon];
  const rsis = valuesFor(rule.rsi, RSI);
  const macds = valuesFor(rule.macd, MACD);
  const adxs = valuesFor(rule.adx, ADX);
  const vols = valuesFor(rule.vol, VOL);
  const confluences = valuesFor(rule.confluence, CONFLUENCE);

  const results = [];
  outer: for (const horizon of horizons) {
    for (const rsi of rsis) {
      for (const macd of macds) {
        for (const adx of adxs) {
          for (const vol of vols) {
            for (const confluence of confluences) {
              const parts = { rsi, macd, adx, vol, confluence, direction: rule.direction, horizon };
              results.push({ stateKey: buildStateKey(parts), horizon });
              if (results.length >= MAX_EXPANDED_ROWS_PER_RULE) break outer;
            }
          }
        }
      }
    }
  }
  return results;
}

function extractionPrompt(chunk) {
  return [
    "You extract structured trading rules from ONE excerpt of a curated trading-knowledge corpus.",
    "Return ONLY a JSON array (no prose, no markdown fences). Each element:",
    "{",
    '  "horizon": "t1" | "t2" | "both",',
    '  "direction": "bullish" | "bearish" | "neutral",',
    `  "rsi": "any" | one of ${JSON.stringify(RSI)},`,
    `  "macd": "any" | one of ${JSON.stringify(MACD)},`,
    `  "adx": "any" | one of ${JSON.stringify(ADX)},`,
    `  "vol": "any" | one of ${JSON.stringify(VOL)},`,
    `  "confluence": "any" | one of ${JSON.stringify(CONFLUENCE)},`,
    '  "rule_text": "one sentence, the actionable claim",',
    '  "quote": "a VERBATIM substring of the excerpt below supporting rule_text",',
    '  "search_terms": ["3-6 questions this excerpt answers, plus synonyms"]',
    "}",
    "Only extract rules that state an actual trading/investing claim tied to horizon and direction.",
    "If the excerpt contains no such claim, return [].",
    "",
    `SOURCE FILE: ${chunk.sourceFile}`,
    "EXCERPT:",
    chunk.body,
  ].join("\n");
}

async function extractRules(apiKey, chunk) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXTRACT_TIMEOUT_MS);
  try {
    const res = await fetch(`${OR_BASE}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://financial.nuwrrrld.com",
        "X-Title": "NuWrrrld grounding-pack compiler",
      },
      body: JSON.stringify({
        model: COMPILE_MODEL,
        temperature: 0,
        messages: [{ role: "user", content: extractionPrompt(chunk) }],
      }),
    });
    if (!res.ok) {
      // 404 means the model id itself is gone, not that this chunk failed.
      // Warning and continuing would compile an empty pack and exit 0, which
      // reads identically to "the corpus had nothing to say" — the failure
      // mode that hid a retired default model behind `rules_extracted=0`.
      if (res.status === 404) {
        throw new Error(
          `model "${COMPILE_MODEL}" returned 404 — it has probably been retired. ` +
            `Refresh the chain (node scripts/refresh-free-models.mjs) or pass COMPILE_MODEL=<id>.`,
        );
      }
      console.warn(`  extract failed [${res.status}] for ${chunk.chunkId}`);
      extractFailures++;
      return [];
    }
    const data = await res.json();
    // A 2xx carrying nothing usable is a failure, not an empty result. Only a
    // well-formed `[]` means "this chunk genuinely had no extractable rule";
    // missing content, no array delimiters, or a non-array payload all mean the
    // call did not answer the question, and must count toward extractFailures —
    // otherwise a provider returning 200-with-empty-content reproduces exactly
    // the silent empty compile this counter exists to catch.
    const raw = data?.choices?.[0]?.message?.content;
    if (typeof raw !== "string") {
      console.warn(`  extract returned no content for ${chunk.chunkId}`);
      extractFailures++;
      return [];
    }
    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    if (start === -1 || end === -1 || start > end) {
      console.warn(`  extract returned no JSON array for ${chunk.chunkId}`);
      extractFailures++;
      return [];
    }
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(parsed)) {
      console.warn(`  extract returned a non-array payload for ${chunk.chunkId}`);
      extractFailures++;
      return [];
    }
    return parsed;
  } catch (err) {
    // A dead model id is fatal for the whole run, not survivable per-chunk;
    // let it out past the per-chunk tolerance so the process exits non-zero.
    if (err instanceof Error && err.message.includes("returned 404")) throw err;
    console.warn(`  extract error for ${chunk.chunkId}: ${err.message}`);
    extractFailures++;
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** A field is valid if it's "any"/absent (defaults to baseline), one vocab value, or an array of vocab values. */
function isValidField(field, vocab) {
  if (field === undefined || field === null || field === "any") return true;
  if (Array.isArray(field)) return field.length > 0 && field.every((v) => vocab.includes(v));
  return vocab.includes(field);
}

function isValidRule(rule, chunkBody) {
  if (!rule || typeof rule !== "object") return false;
  if (!["t1", "t2", "both"].includes(rule.horizon)) return false;
  if (!DIRECTIONS.includes(rule.direction)) return false;
  if (typeof rule.rule_text !== "string" || !rule.rule_text.trim()) return false;
  if (typeof rule.quote !== "string" || !rule.quote.trim()) return false;
  // Reject hallucinated bucket values now — an invalid value here would silently
  // expand into a state_key that no live signal can ever produce (dead evidence).
  if (!isValidField(rule.rsi, RSI)) return false;
  if (!isValidField(rule.macd, MACD)) return false;
  if (!isValidField(rule.adx, ADX)) return false;
  if (!isValidField(rule.vol, VOL)) return false;
  if (!isValidField(rule.confluence, CONFLUENCE)) return false;
  // The anti-hallucination gate: the quote must appear verbatim in the chunk.
  if (!chunkBody.includes(rule.quote.trim())) return false;
  return true;
}

/**
 * One multi-row INSERT ... ON CONFLICT for `rows.length` rows instead of one
 * round trip per row — the @neondatabase/serverless HTTP client makes a
 * separate network request per `sql\`...\`` call, so per-row inserts turn a
 * modest corpus into thousands of sequential requests.
 */
async function batchUpsert(sql, table, columns, rows, conflictColumns, setClauses) {
  if (!rows.length) return;
  const values = [];
  const rowPlaceholders = rows.map((row) => {
    const placeholders = row.map((value) => {
      values.push(value);
      return `$${values.length}`;
    });
    return `(${placeholders.join(", ")})`;
  });
  const text = `
    INSERT INTO ${table} (${columns.join(", ")})
    VALUES ${rowPlaceholders.join(", ")}
    ON CONFLICT (${conflictColumns.join(", ")}) DO UPDATE SET ${setClauses.join(", ")}
  `;
  await sql.query(text, values);
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!DRY_RUN && !apiKey) {
    console.error("OPENROUTER_API_KEY is required (or pass --dry-run).");
    process.exit(1);
  }
  if (!DRY_RUN && !COMPILE_MODEL) {
    console.error(
      "No extraction model: COMPILE_MODEL is unset and FREE_MODEL_CHAIN could not be " +
        "read from lib/openrouter.ts. Pass COMPILE_MODEL=<id> explicitly.",
    );
    process.exit(1);
  }

  const sql = neon(dbUrl);
  const version = corpusVersion();
  console.log(
    `Compiling grounding pack — corpus_version=${version}, taxonomy=${TAXONOMY_VERSION}` +
      (DRY_RUN ? " (dry run, no extraction)" : `, model=${COMPILE_MODEL}`),
  );

  const files = await walkMarkdown(CORPUS_DIR);
  console.log(`Found ${files.length} corpus file(s) under ${relative(repoRoot, CORPUS_DIR)}/`);

  let totalChunks = 0;
  let totalRules = 0;
  let totalRows = 0;
  let totalRejected = 0;

  for (const filePath of files) {
    const sourceFile = relative(CORPUS_DIR, filePath);
    const text = await readFile(filePath, "utf8");
    const chunks = chunkDocument({ sourceFile, text });
    const traderFilter = traderFilterForFile(sourceFile);
    totalChunks += chunks.length;

    // Extract first (no DB dependency), then batch both tables' writes for
    // the whole file into one INSERT each instead of one per chunk/rule.
    const chunkResults = [];
    for (const chunk of chunks) {
      const before = extractFailures;
      const rules = DRY_RUN ? [] : await extractRules(apiKey, chunk);
      const failed = extractFailures > before;
      const validRules = rules.filter((r) => isValidRule(r, chunk.body));
      totalRejected += rules.length - validRules.length;
      totalRules += validRules.length;
      chunkResults.push({ chunk, validRules, failed });
    }

    if (!DRY_RUN) {
      // Skip chunks whose extraction call failed. The upsert replaces
      // `search_terms` outright, so writing a failed chunk would erase terms a
      // previous good run had compiled — losing data on the strength of a 429.
      // A chunk that answered with a genuine `[]` is still written: empty terms
      // are then a real result, not a gap.
      const writableResults = chunkResults.filter(({ failed }) => !failed);
      const skippedWrites = chunkResults.length - writableResults.length;
      if (skippedWrites > 0) {
        console.warn(
          `  not persisting ${skippedWrites} chunk(s) whose extraction failed ` +
            `(existing rows left intact)`,
        );
      }
      const chunkRows = writableResults.map(({ chunk, validRules }) => {
        const searchTerms = validRules.flatMap((r) => r.search_terms ?? []);
        return [chunk.chunkId, chunk.sourceFile, traderFilter, [], chunk.body, searchTerms];
      });
      await batchUpsert(
        sql,
        "corpus_chunks",
        ["chunk_id", "source_file", "trader_filter", "tags", "body", "search_terms"],
        chunkRows,
        ["chunk_id"],
        ["body = EXCLUDED.body", "trader_filter = EXCLUDED.trader_filter", "search_terms = EXCLUDED.search_terms", "updated_at = now()"],
      );

      // Keyed by (state_key, chunk_id) — the batch's own ON CONFLICT target —
      // so two rules expanding to the same pair (e.g. both defaulting to the
      // same baseline bucket) don't make Postgres see one INSERT try to
      // "affect row a second time".
      const packRowsByKey = new Map();
      for (const { chunk, validRules } of writableResults) {
        for (const rule of validRules) {
          for (const { stateKey, horizon } of expandRule(rule)) {
            packRowsByKey.set(`${stateKey} ${chunk.chunkId}`, [
              stateKey, horizon, rule.direction, rule.rule_text, rule.quote,
              chunk.chunkId, chunk.sourceFile, [], 1.0, version, TAXONOMY_VERSION,
            ]);
          }
        }
      }
      const packRows = [...packRowsByKey.values()];
      totalRows += packRows.length;
      await batchUpsert(
        sql,
        "grounding_pack",
        [
          "state_key", "horizon", "direction", "rule_text", "quote", "chunk_id",
          "source_file", "tags", "confidence", "corpus_version", "taxonomy_version",
        ],
        packRows,
        ["state_key", "chunk_id"],
        ["rule_text = EXCLUDED.rule_text", "quote = EXCLUDED.quote", "corpus_version = EXCLUDED.corpus_version", "compiled_at = now()"],
      );
    } else {
      const dryKeys = new Set();
      for (const { chunk, validRules } of writableResults) {
        for (const rule of validRules) {
          for (const { stateKey } of expandRule(rule)) dryKeys.add(`${stateKey} ${chunk.chunkId}`);
        }
      }
      totalRows += dryKeys.size;
    }

    console.log(`  ${sourceFile}: ${chunks.length} chunk(s)`);
  }

  console.log(
    `\nDone. chunks=${totalChunks} rules_extracted=${totalRules} ` +
      `rejected(unverbatim/invalid)=${totalRejected} pack_rows=${totalRows}` +
      (extractFailures ? ` extract_failures=${extractFailures}` : "") +
      (DRY_RUN ? " (dry-run, nothing written)" : ""),
  );

  // Every chunk failed to reach the model: the pack is empty because nothing
  // was asked, not because the corpus had nothing to say. Exiting 0 here is
  // what let a retired model id and an exhausted daily quota both read as a
  // successful no-op run. Nothing was persisted for a failed chunk (see the
  // writableResults filter), so "left unchanged" is literally true here.
  if (!DRY_RUN && totalChunks > 0 && extractFailures === totalChunks) {
    throw new Error(
      `all ${totalChunks} extraction call(s) failed — no rule could be compiled. ` +
        `Check the model id and the OpenRouter quota; the pack was left unchanged.`,
    );
  }
}

main().catch((err) => {
  console.error(`\ncompile_grounding_pack failed: ${err.message}`);
  process.exit(1);
});
