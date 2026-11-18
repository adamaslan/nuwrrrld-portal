import {describe,it,expect} from 'vitest';
import {downsideFollowThroughFailure,type Bar} from '@/lib/shared/se1/bottom-scans';
const run=(tail:(number|null)[])=>{
 const bars:Bar[]=[100,100,100,100,100,90,...tail].map((c,i)=>({date:`2026-01-${String(i+1).padStart(2,'0')}`,open:c,high:c===null?null:c+1,low:c===null?null:c-1,close:c,volume:100}));
 const r=downsideFollowThroughFailure(bars,{cutoff:bars.at(-1)!.date,supportWindow:5});
 if(r.status!=='computed')throw Error('expected computed');return r.events[0].state;
};
describe('independent review: missing close cannot prove no downside extension',()=>{
 it('keeps missing-window recovery pending',()=>expect(run([null,96,97])).toBe('pending'));
 it('retains directly observed continuation despite missing data',()=>expect(run([null,89,97])).toBe('continued'));
 it('still confirms a fully observed failed extension',()=>expect(run([91,96,97])).toBe('failed_extension'));
});
