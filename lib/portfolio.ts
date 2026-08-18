/**
 * Portfolio intelligence types — single-sourced for app and web.
 * Health score + optimizer suggestions schema.
 */

export type HealthGrade = 'A' | 'B' | 'C' | 'D' | 'F';

export interface HealthFactor {
  name: string;
  score: number;       // 0–100
  impact: 'positive' | 'negative' | 'neutral';
  description: string;
}

export interface PortfolioHealth {
  score: number;       // 0–100
  grade: HealthGrade;
  factors: HealthFactor[];
  summary: string;
  generatedAt: string; // ISO
}

function isHealthFactor(value: unknown): value is HealthFactor {
  if (!value || typeof value !== 'object') return false;
  const f = value as Record<string, unknown>;
  return (
    typeof f.name === 'string' &&
    typeof f.score === 'number' &&
    (f.impact === 'positive' || f.impact === 'negative' || f.impact === 'neutral') &&
    typeof f.description === 'string'
  );
}

/**
 * Validates a PortfolioHealth response client-side. Catches contract drift
 * from an unadapted upstream payload (e.g. gcp3's ai_grade/ai_insights shape)
 * that would otherwise pass an unchecked `as PortfolioHealth` cast and render
 * as a silent "score 0 / Grade F" — see
 * docs/wiki-portal/incident-2026-07-26-portfolio-health-endpoint-missing.md.
 */
export function isPortfolioHealth(value: unknown): value is PortfolioHealth {
  if (!value || typeof value !== 'object') return false;
  const h = value as Record<string, unknown>;
  return (
    typeof h.score === 'number' &&
    typeof h.grade === 'string' &&
    Array.isArray(h.factors) && h.factors.every(isHealthFactor) &&
    typeof h.summary === 'string' &&
    typeof h.generatedAt === 'string'
  );
}

export interface OptimizerSuggestion {
  id: string;
  title: string;
  rationale: string;
  /** Optional ticker this suggestion relates to */
  ticker?: string;
  priority: 'high' | 'medium' | 'low';
  /** Informational only — not personalised financial advice */
  disclaimer: string;
}

export interface WatchlistItem {
  ticker: string;
  addedAt: string; // ISO
  alertThreshold?: {
    priceAbove?: number;
    priceBelow?: number;
    signalFired?: boolean;
  };
}

export function gradeFromScore(score: number): HealthGrade {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

export const PORTFOLIO_DISCLAIMER =
  'Portfolio analysis is informational only and is not personalised financial advice. ' +
  'All suggestions are educational and should not be acted upon without independent research.';
