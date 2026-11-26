import {describe,it,expect} from 'vitest';
import {longTrendSlopeCurvature} from '@/lib/shared/se1/bar-only-batch-04';
const bar=(date:string,close:number)=>({date,open:close,high:close+1,low:close-1,close,volume:100});
describe('independent current-head input integrity review',()=>{
 it('does not count one repeated session as four daily observations',()=>{
  const rows=[10,11,12,13].map(c=>bar('2026-04-01',c));
  expect(()=>longTrendSlopeCurvature(rows,{cutoff:'2026-04-02',window:3,nearZeroSlope:0})).toThrow();
 });
 it('does not include an offset timestamp after the as-of instant',()=>{
  const rows=[bar('2026-04-01',10),bar('2026-04-02',11),bar('2026-04-03',12),bar('2026-04-03T23:30:00-04:00',100)];
  const cutoff='2026-04-04T00:00:00Z';
  expect(Date.parse(rows[3].date)).toBeGreaterThan(Date.parse(cutoff));
  const result=longTrendSlopeCurvature(rows,{cutoff,window:3,nearZeroSlope:0});
  expect(result.status).toBe('unsupported');
 });
});
