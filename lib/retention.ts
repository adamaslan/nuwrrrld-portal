/**
 * Retention primitives — single-sourced for app and web.
 */

export interface StreakState {
  currentStreak: number;
  longestStreak: number;
  lastActiveDate: string;   // YYYY-MM-DD UTC
  updatedAt: string;        // ISO
}

export type EmailDigestFrequency = 'weekly' | 'daily' | 'off';

export interface RetentionPreferences {
  emailDigest: EmailDigestFrequency;
  trialNudgesSeen: number;
}

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export function advanceStreak(current: StreakState): StreakState {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  if (current.lastActiveDate === today) return current;

  // Use a single Date base to avoid midnight race between two new Date() calls.
  const yesterday = new Date(now);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);

  const newStreak = current.lastActiveDate === yesterdayStr
    ? current.currentStreak + 1
    : 1;

  return {
    currentStreak: newStreak,
    longestStreak: Math.max(current.longestStreak, newStreak),
    lastActiveDate: today,
    updatedAt: now.toISOString(),
  };
}
