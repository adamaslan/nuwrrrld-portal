import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import {readQualityEvidence,unrecoveredNewsAccuracyEvidence} from '../lib/nulogdash-quality.mjs';
const runnerFunction = "function localQualityEvidence() {\n  if (!existsSync(QUALITY_FILE)) {\n    return readQualityEvidence(unrecoveredNewsAccuracyEvidence());\n  }\n  try {\n    return readQualityEvidence(JSON.parse(readFileSync(QUALITY_FILE, \"utf8\")));\n  } catch {\n    const quality = unrecoveredNewsAccuracyEvidence();\n    return readQualityEvidence({ ...quality, displayReason: \"Quality not recorded: the local quality-evidence artifact could not be read.\" });\n  }\n}\n";
describe('actual runner quality fallback boundary, offline only',()=>{
 for(const mode of ['absent','malformed','unreadable']) it(mode,()=>{
  const local = vm.runInNewContext('('+runnerFunction+')',{QUALITY_FILE:'synthetic-only',existsSync:()=>mode!=='absent',readFileSync:()=>{if(mode==='unreadable')throw Error('fixture');return '{';},readQualityEvidence,unrecoveredNewsAccuracyEvidence});
  const result=local(); expect(result.metrics).toHaveLength(13); expect(result.metrics.every(m=>m.verdict!=='meets_target')).toBe(true);expect(result.metrics.find(m=>m.id==='delta_ic_h5').valueState).toBe('null');
 });
});
