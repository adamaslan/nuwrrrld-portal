/**
 * Retention primitives — single-sourced for app and web.
 * Streak: consecutive days a user opened the app or viewed a digest.
 * Weekly digest email: opted-in users get a summary every Monday.
 */

export interface StreakState {
  currentStreak: number;    // consecutive days
  longestStreak: number;
  lastActiveDate: string;   // YYYY-MM-DD UTC
  updatedAt: string;        // ISO
}

export type EmailDigestFrequency = 'weekly' | 'daily' | 'off';

export interface RetentionPreferences {
  emailDigest: EmailDigestFrequency;
  trialNudgesSeen: number;   // suppress after 3
}

/** Return today's date in YYYY-MM-DD UTC. */
export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Advance streak by one day or reset if gap > 1 day. */
export function advanceStreak(current: StreakState): StreakState {
  const today = todayUtc();
  if (current.lastActiveDate === today) return current; // already counted today

  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);

  const newStreak = current.lastActiveDate === yesterdayStr
    ? current.currentStreak + 1
    : 1; // gap — reset

  return {
    currentStreak: newStreak,
    longestStreak: Math.max(current.longestStreak, newStreak),
    lastActiveDate: today,
    updatedAt: new Date().toISOString(),
  };
}
