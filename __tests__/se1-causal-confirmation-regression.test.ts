import {it,expect} from 'vitest';
import {transitionAfterLongAverageReclaim} from '../lib/shared/se1/bar-only-batch-03';
import {compressionDurationPercentile} from '../lib/shared/se1/bar-only-batch-04';
const bar=(i:number,close:number,width=2)=>({date:`2026-03-${String(i+1).padStart(2,'0')}`,open:close,close,high:close+width/2,low:close-width/2,volume:100});
it('does not confirm a higher low after the reclaim already failed',()=>{
 const rows=[25,24,8,9,9.5,10,15,16,12,12.1,12.2].map((c,i)=>bar(i,c));
 const result=transitionAfterLongAverageReclaim(rows,{cutoff:'2026-03-11',longWindow:6,pivotK:2});
 expect(result.events?.find(e=>e.reclaim_date==='2026-03-07')).toMatchObject({state:'failed_reclaim',higher_low_date:null,higher_low_available_date:null});
});
it('does not count a trailing expanded bar as current compression',()=>{
 const rows=[1,4,1,4].map((width,i)=>bar(i,100,width));
 expect(compressionDurationPercentile(rows,{cutoff:'2026-03-04',compressionWidth:.02,minCompletedRuns:1})).toMatchObject({status:'computed',current_run:0,percentile:0});
});

import {defensiveSectorRotation,horizonDisagreementAge} from '../lib/shared/se1/bar-only-batch-03';
it('matches equivalent basket endpoints across offsets and excludes future index rows',()=>{
 const members=['defensive','cyclical'].map((category,i)=>({ticker:'X'+i,category:category as 'defensive'|'cyclical',weight:1,basis:'total_return' as const,bars:[{date:'2026-03-01T11:00:00-05:00',close:100},{date:'2026-03-02T11:00:00-05:00',close:110-i*5}]}));
 const index=[{date:'2026-03-01T16:00:00Z',close:100},{date:'2026-03-02T16:00:00Z',close:101},{date:'2026-03-02T12:00:00-05:00',close:NaN}];
 expect(defensiveSectorRotation(members,index,{cutoff:'2026-03-02T16:00:00Z',indexWindow:2,nearHighRatio:.9})).toMatchObject({status:'computed',missing_legs:[],spread_pct:expect.closeTo(5)});
});
it('rejects equivalent oscillator duplicate instants',()=>{
 expect(()=>horizonDisagreementAge([{date:'2026-03-01T16:00:00Z',price:100,oscillator:1},{date:'2026-03-01T11:00:00-05:00',price:101,oscillator:2}],{cutoff:'2026-03-02',pivotK:1,weaknessBuffer:.01})).toThrow(/unique/);
});
