import {describe,it,expect} from 'vitest';
import {baseWidthVersusDepth} from '@/lib/shared/se1/bar-only-batch-01';
import {failedBreakoutShelfLoss} from '@/lib/shared/se1/bar-only-batch-02';
import {movingAverageStackRepair} from '@/lib/shared/se1/bar-only-batch-03';
import {longTrendSlopeCurvature} from '@/lib/shared/se1/bar-only-batch-04';
import {volatilityEstimatorDisagreement} from '@/lib/shared/se1/bar-only-batch-05';
const bar=(date:string,close:number)=>({date,open:close,high:close+1,low:close-1,close,volume:100});
const cutoff='2026-04-04T00:00:00Z';
const scans=[
 (b:any[])=>baseWidthVersusDepth(b,{cutoff,window:8,supportBand:0.1,maxSupportDrift:0.1}),
 (b:any[])=>failedBreakoutShelfLoss(b,{cutoff,shelf:11,holdBars:3,atrWindow:2,breakoutBuffer:0}),
 (b:any[])=>movingAverageStackRepair(b,{cutoff,shortWindow:2,mediumWindow:3,longWindow:4}),
 (b:any[])=>longTrendSlopeCurvature(b,{cutoff,window:3,nearZeroSlope:0}),
 (b:any[])=>volatilityEstimatorDisagreement(b,{cutoff,window:2})
];
describe('daily-bar input boundary family',()=>{
 for(let i=0;i<scans.length;i++){
  it(`batch${i+1} rejects duplicate instants`,()=>expect(()=>scans[i]([bar('2026-04-01',10),bar('2026-04-01T00:00:00Z',11)])).toThrow());
  it(`batch${i+1} ignores excluded numeric poison and offset-after-cutoff`,()=>{
   const rows=[bar('2026-04-01',10),bar('2026-04-02',11),bar('2026-04-03',12)];
   const {excluded_after_cutoff: count, ...actual}=scans[i]([...rows,bar('2026-04-03T23:30:00-04:00',NaN)]) as any;
   const {excluded_after_cutoff: baselineCount, ...baseline}=scans[i](rows) as any;
   expect(actual).toEqual(baseline);
   if(baselineCount !== undefined) expect(count).toBe(baselineCount + 1);
  });
 }
});
