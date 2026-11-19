import { describe,it,expect } from 'vitest';
import { breakdownDistance,type OhlcBar } from '@/lib/shared/se1/trend-vol-scans';
const bars:OhlcBar[]=[
 {date:'2026-01-01',open:100,high:101,low:99,close:100},
 {date:'2026-01-02',open:99,high:100,low:98,close:99},
 {date:'2026-01-03',open:1,high:2,low:0,close:0},
];
describe('independent review: zero terminal close cannot define percentage distance',()=>{
 it('rejects zero last close instead of reporting computed negative infinity',()=>{
  expect(breakdownDistance(bars,'2026-01-03',90,2)).toEqual({status:'unsupported',reason:'zero close at cutoff'});
 });
});
