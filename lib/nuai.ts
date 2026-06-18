/**
 * Nu AI assistant — shared types and guardrails.
 * The actual LLM call lives server-side (portal API) to protect the API key
 * and enforce rate limits. This module defines the contract both surfaces use.
 */

export const NU_AI_DISCLAIMER =
  'Nu AI provides informational responses only and is not personalised financial, ' +
  'investment, legal, or tax advice. Always perform your own due diligence.';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string; // ISO
}

export interface ChatRequest {
  messages: ChatMessage[];
  /** Ticker symbols the user currently holds — injected as context. */
  portfolioContext?: string[];
}

export interface ChatResponse {
  message: ChatMessage;
  /** Whether the response was cut short by a safety guardrail. */
  flagged?: boolean;
}

/** Out-of-scope topics Nu AI refuses to answer */
const REFUSED_PATTERNS = [
  /\b(tax evasion|insider trading|market manipulation|pump.?and.?dump)\b/i,
  /\b(specific (price )?target|buy exactly|sell exactly)\b/i,
];

export function isRefusedQuery(text: string): boolean {
  return REFUSED_PATTERNS.some(p => p.test(text));
}

/** Per-user daily token budget cap (approximate) */
export const NU_AI_DAILY_TOKEN_BUDGET = 50_000;
