import { describe,expect,it } from 'vitest';
import { evaluateMaDistance,replayMaDistance,type DossierInput } from '@/lib/engine/research/ma-distance';
const date=(i:number)=>new Date(Date.UTC(2026,7,1+i)).toISOString().slice(0,10);
function fixture(n=60):DossierInput {
  return {symbol:'TEST',source:'synthetic linear fixture',priceBasis:'split-adjusted-ohlc',bars:Array.from({length:n},(_,i)=>({date:date(i),open:100+i,close:100+i,high:101+i,low:99+i,volume:1000}))};
}
describe('MA50/ATR14 research dossier',()=>{
  it('matches a hand calculation without inventing another confluence vote',()=>{
    const r=evaluateMaDistance(fixture(),date(59));
    expect(r).toMatchObject({status:'available',close:159,sma50:134.5,atr14:2,distanceAtr:12.25,confluenceWeight:0,promoted:false,basisIndependentlyVerified:false});
    expect(r.distancePercent).toBeCloseTo((159/134.5-1)*100,10);
  });
  it('requires a complete window and keeps missing separate from zero',()=>{
    expect(evaluateMaDistance(fixture(49),date(48))).toMatchObject({status:'insufficient_history',distanceAtr:null});
    const f=fixture();f.bars=f.bars.map(b=>({...b,open:100,close:100,high:101,low:99}));
    expect(evaluateMaDistance(f,date(59))).toMatchObject({status:'available',distanceAtr:0});
  });
  it('future price mutation cannot change a prior result or input hash',()=>{
    const f=fixture(75),copy=structuredClone(f);copy.bars=copy.bars.map((b,i)=>i>55?{...b,open:8000,close:9000,high:10000,low:7000}:b);
    expect(evaluateMaDistance(f,date(55))).toEqual(evaluateMaDistance(copy,date(55)));
    expect(replayMaDistance(f).slice(0,56)).toEqual(replayMaDistance(copy).slice(0,56));
  });
  it('prefix replay equals independently truncated inputs',()=>{
    const f=fixture();replayMaDistance(f).forEach((r,i)=>expect(r).toEqual(evaluateMaDistance({...f,bars:f.bars.slice(0,i+1)},date(i))));
  });
  it.each(['raw','unknown'] as const)('withholds %s basis rather than guessing a split repair',priceBasis=>{
    expect(evaluateMaDistance({...fixture(),priceBasis},date(59))).toMatchObject({status:'withheld',reason:'unknown_or_raw_price_basis'});
  });
  it.each([NaN,Infinity,-1,0])('withholds bad price %s',bad=>{
    const f=fixture();f.bars= f.bars.map((b,i)=>i===20?{...b,close:bad}:b);
    expect(evaluateMaDistance(f,date(59)).status).toBe('withheld');
  });
  it('rejects future evaluation dates rather than certifying invented future sessions',()=>{
    expect(()=>evaluateMaDistance(fixture(),'2099-01-01')).toThrow('future completed session');
  });
  it('rejects duplicate, unordered and invalid calendar dates',()=>{
    const f=fixture();for(const bars of [[...f.bars,f.bars[0]],[...f.bars].reverse(),[{...f.bars[0],date:'2026-02-30'}]])expect(()=>evaluateMaDistance({...f,bars},date(59))).toThrow();
  });
  it('withholds gaps, stale bars and zero volatility',()=>{
    const f=fixture();expect(evaluateMaDistance(f,date(70)).reason).toBe('stale_last_bar');
    expect(evaluateMaDistance({...f,bars:f.bars.filter((_,i)=>i<10||i>20)},date(59)).reason).toBe('requires_50_completed_bars');
    const g=fixture(75);expect(evaluateMaDistance({...g,bars:g.bars.filter((_,i)=>i<10||i>20)},date(74)).reason).toBe('calendar_gap_over_7_days');
    expect(evaluateMaDistance({...f,bars:f.bars.map(b=>({...b,open:100,close:100,high:100,low:100}))},date(59)).reason).toBe('invalid_or_zero_atr');
  });
  it('preserves the input and hashes source/basis/formula inputs reproducibly',()=>{
    const f=fixture(),copy=structuredClone(f);const a=evaluateMaDistance(f,date(59));
    expect(f).toEqual(copy);expect(a.inputHash).toHaveLength(64);
    expect(evaluateMaDistance({...f,source:'other source'},date(59)).inputHash).not.toBe(a.inputHash);
  });
});
