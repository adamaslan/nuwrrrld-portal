import { describe, expect, it, vi } from 'vitest';
import { adaptReturns } from '@/lib/shared/signalReturns';
import { sortSignals, normalizeSort, returnRanking } from '@/lib/shared/signalFilters';
import { adaptLiveSignals, type SignalPayload } from '@/lib/digest';
const meta = {'1d': {start:'2026-11-09',end:'2026-11-10',price_basis:'split-adjusted-close',verified:true}};
function s(ticker:string, value:unknown, metadata:unknown=meta): SignalPayload { return {id:ticker,ticker,title:'fake +9999%',direction:'neutral',timeframe:'medium',confidence:'low',explanation:'',indicators:[],generatedAt:'2026-11-10T22:00:00Z',isStale:false,returns:adaptReturns({'1d':value},metadata,false)}; }
describe('source-grounded return ranking',()=>{
  vi.setSystemTime(new Date('2026-11-11T17:00:00Z'));
  it('sorts numbers not strings/titles, filters gainers/losers, leaves original unchanged',()=>{
    const rows=[s('A',2),s('B',12),s('C',-1),s('D',-10),s('Z',0),s('M',null)];
    expect(sortSignals(rows,'1d-gainers').map(x=>x.ticker)).toEqual(['B','A']);
    expect(sortSignals(rows,'1d-losers').map(x=>x.ticker)).toEqual(['D','C']);
    expect(rows.map(x=>x.ticker)).toEqual(['A','B','C','D','Z','M']);
    expect(returnRanking(rows,'1d-gainers')).toMatchObject({eligible:4,flat:1,withheld:1});
  });
  it('breaks ties deterministically and rejects unknown saved sorts',()=>{
    expect(sortSignals([s('B',2),s('A',2)],'1d-gainers').map(x=>x.ticker)).toEqual(['A','B']);
    expect(normalizeSort('timeframe')).toBe('confidence');
    expect(normalizeSort('made-up')).toBe('confidence');
  });
  it('withholds stale, future, missing, NaN, Infinity, strings and unverified/split-unknown data',()=>{
    for(const x of [null, NaN, Infinity,'12',-101])expect(adaptReturns({'1d':x},meta,false)['1d'].status).not.toBe('available');
    expect(adaptReturns({'1d':2},meta,true)['1d'].status).toBe('stale');
    expect(adaptReturns({'1d':2},{},false)['1d'].status).toBe('invalid_basis');
    expect(adaptReturns({'1d':2},{'1d':{...meta['1d'],end:'2099-01-01'}},false)['1d'].status).toBe('invalid_basis');
  });
  it('rejects invalid calendar dates and never infers return values from a headline',()=>{
    expect(adaptReturns({'1d':2},{'1d':{...meta['1d'],start:'2026-02-30'}},false)['1d'].status).toBe('invalid_basis');
    const d=adaptLiveSignals({updated:'2026-11-11T16:00:00Z',symbols:{A:{ai_summary:'1d +99%',returns:{'1d':2}}}});
    expect(d.signals[0].returns?.['1d']).toMatchObject({value:2,status:'invalid_basis'});
  });
  it('does not compare mixed interval endpoints as one ranking snapshot',()=>{
    const a=s('A',2),b=s('B',3,{'1d':{...meta['1d'],start:'2026-11-08'}});
    expect(sortSignals([a,b],'1d-gainers')).toEqual([]);
  });
});
