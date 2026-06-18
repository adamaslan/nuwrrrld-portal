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
