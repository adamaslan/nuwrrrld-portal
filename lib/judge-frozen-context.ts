/** Stored with the exact authored verdict, never reconstructed at grade time. */
export interface FrozenJudgeContext { version: 1; brief: string; authorModel: string }
export function freezeJudgeContext(brief: string, authorModel: string): FrozenJudgeContext {
  if (!brief.trim() || brief.length > 100_000 || !authorModel.trim() || authorModel.length > 300) throw new Error('Invalid frozen judge context');
  return { version: 1, brief, authorModel };
}
export function readFrozenJudgeContext(raw: unknown): FrozenJudgeContext | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  // Validator failures must not be laundered into a reasoning-quality score.
  if (!Array.isArray(record.validatorFlags) || record.validatorFlags.length !== 0) return null;
  const c = record.judgeContext;
  if (!c || typeof c !== 'object') return null;
  const value = c as Record<string, unknown>;
  if (value.version !== 1 || typeof value.brief !== 'string' || typeof value.authorModel !== 'string') return null;
  try { return freezeJudgeContext(value.brief, value.authorModel); } catch { return null; }
}
