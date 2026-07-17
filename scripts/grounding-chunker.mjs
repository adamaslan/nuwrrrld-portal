/**
 * grounding-chunker — file-aware chunking for the compile-time grounding
 * pipeline (docs/ai-council-timeline.html, PR 2 — "Compiler").
 *
 * Ports the one piece of ai-text-opt-1024 with lasting value: its
 * ingest.py chunking rules (PROSE_CHUNK_SIZE=480/overlap=96,
 * QA_CHUNK_SIZE=300/overlap=40, MIN_CHUNK_TOKENS=80 stub filter, filename
 * patterns picking the QA splitter). ai-text-opt-1024 used llama_index's
 * SentenceSplitter with a real tokenizer; this port approximates "tokens"
 * as whitespace-delimited words (same order of magnitude, zero deps) —
 * fine here because chunk boundaries only need to be roughly consistent,
 * not byte-identical to the Python originals.
 */
import { createHash } from "node:crypto";

export const PROSE_CHUNK_SIZE = 480;
export const PROSE_CHUNK_OVERLAP = 96;
export const QA_CHUNK_SIZE = 300;
export const QA_CHUNK_OVERLAP = 40;
export const MIN_CHUNK_TOKENS = 80;
export const QA_PATTERNS = ["t1-", "t2-", "-qa.md", "-100-questions"];

export function isQaFile(filename) {
  const lower = filename.toLowerCase();
  return QA_PATTERNS.some((p) => lower.includes(p));
}

/** Infer a T1/T2 filename tag the same way the corpus's own naming already does. */
export function traderFilterForFile(filename) {
  const lower = filename.toLowerCase();
  if (lower.includes("t1-")) return "T1";
  if (lower.includes("t2-")) return "T2";
  return null;
}

function splitSentences(text) {
  return text
    .split(/(?<=[.?!])\s+(?=[A-Z0-9"'*_#-])|\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function approxTokens(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

function sha1(input) {
  return createHash("sha1").update(input).digest("hex");
}

function packSentences(sentences, chunkSizeTokens, overlapTokens) {
  const chunks = [];
  let current = [];
  let currentTokens = 0;

  for (const sentence of sentences) {
    const sentenceTokens = approxTokens(sentence);
    if (currentTokens + sentenceTokens > chunkSizeTokens && current.length) {
      chunks.push(current.join(" "));
      const overlap = [];
      let overlapCount = 0;
      for (let i = current.length - 1; i >= 0 && overlapCount < overlapTokens; i--) {
        overlap.unshift(current[i]);
        overlapCount += approxTokens(current[i]);
      }
      current = overlap;
      currentTokens = overlapCount;
    }
    current.push(sentence);
    currentTokens += sentenceTokens;
  }
  if (current.length) chunks.push(current.join(" "));
  return chunks;
}

/**
 * Chunk one source document.
 * `doc` = { sourceFile: string, text: string }
 * Returns [{ chunkId, sourceFile, chunkIndex, body, charLen, contentHash }]
 */
export function chunkDocument(doc) {
  const isQa = isQaFile(doc.sourceFile);
  const chunkSize = isQa ? QA_CHUNK_SIZE : PROSE_CHUNK_SIZE;
  const overlap = isQa ? QA_CHUNK_OVERLAP : PROSE_CHUNK_OVERLAP;

  const sentences = splitSentences(doc.text);
  const rawChunks = packSentences(sentences, chunkSize, overlap);
  const fileHash = sha1(doc.sourceFile).slice(0, 12);

  const chunks = [];
  let index = 0;
  for (const raw of rawChunks) {
    const body = raw.trim();
    if (!body) continue;
    // Drop stub chunks — ~4 chars/token for English prose (matches ingest.py).
    if (body.length < MIN_CHUNK_TOKENS * 4) continue;
    chunks.push({
      chunkId: `${fileHash}_${String(index).padStart(5, "0")}`,
      sourceFile: doc.sourceFile,
      chunkIndex: index,
      body,
      charLen: body.length,
      contentHash: sha1(body),
    });
    index++;
  }
  return chunks;
}
