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
const COMPILE_MODEL = process.env.COMPILE_MODEL ?? "qwen/qwen3-next-80b-a3b-instruct:free";
const EXTRACT_TIMEOUT_MS = 30_000;
const MAX_EXPANDED_ROWS_PER_RULE = 24; // guards against a Cartesian blow-up on under-constrained rules
const DRY_RUN = process.argv.includes("--dry-run");

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
      console.warn(`  extract failed [${res.status}] for ${chunk.chunkId}`);
      return [];
    }
    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content ?? "[]";
    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    if (start === -1 || end === -1 || start > end) return [];
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn(`  extract error for ${chunk.chunkId}: ${err.message}`);
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

  const sql = neon(dbUrl);
  const version = corpusVersion();
  console.log(`Compiling grounding pack — corpus_version=${version}, taxonomy=${TAXONOMY_VERSION}`);

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
      const rules = DRY_RUN ? [] : await extractRules(apiKey, chunk);
      const validRules = rules.filter((r) => isValidRule(r, chunk.body));
      totalRejected += rules.length - validRules.length;
      totalRules += validRules.length;
      chunkResults.push({ chunk, validRules });
    }

    if (!DRY_RUN) {
      const chunkRows = chunkResults.map(({ chunk, validRules }) => {
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
      for (const { chunk, validRules } of chunkResults) {
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
      for (const { chunk, validRules } of chunkResults) {
        for (const rule of validRules) {
          for (const { stateKey } of expandRule(rule)) dryKeys.add(`${stateKey} ${chunk.chunkId}`);
        }
      }
      totalRows += dryKeys.size;
    }

    console.log(`  ${sourceFile}: ${chunks.length} chunk(s)`);
  }

  console.log(
    `\nDone. chunks=${totalChunks} rules_extracted=${totalRules} rejected(unverbatim/invalid)=${totalRejected} pack_rows=${totalRows}${DRY_RUN ? " (dry-run, nothing written)" : ""}`,
  );
}

main().catch((err) => {
  console.error(`\ncompile_grounding_pack failed: ${err.message}`);
  process.exit(1);
});
