import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import {readQualityEvidence,unrecoveredNewsAccuracyEvidence} from '../lib/nulogdash-quality.mjs';
const runnerSource = readFileSync('scripts/nulogdash.mjs', 'utf8');
const runnerFunction = runnerSource.match(/function localQualityEvidence\(\) \{[\s\S]*?\n\}/)?.[0];
if (!runnerFunction) throw new Error('Runner quality boundary not found');

describe('actual runner quality fallback boundary, offline only',()=>{
 for(const mode of ['absent','malformed','unreadable']) it(mode,()=>{
  const local = vm.runInNewContext('('+runnerFunction+')',{QUALITY_FILE:'synthetic-only',existsSync:()=>mode!=='absent',readFileSync:()=>{if(mode==='unreadable')throw Error('fixture');return '{';},readQualityEvidence,unrecoveredNewsAccuracyEvidence});
  const result=local(); expect(result.metrics).toHaveLength(13); expect(result.metrics.every(m=>m.verdict!=='meets_target')).toBe(true);expect(result.metrics.find(m=>m.id==='delta_ic_h5').valueState).toBe('null');
 });
});
