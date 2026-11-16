import {describe,it,expect} from 'vitest';
import {detectHoldingsAlerts,type SignalSnapshot} from '@/lib/holdings-alerts';
const snap=(generatedAt:string, direction:SignalSnapshot['direction'],more:Partial<SignalSnapshot>={}):SignalSnapshot=>({ticker:'AAA',direction,generatedAt,isStale:false,dataQualityScore:'fresh',...more});
describe('review fail-closed edges',()=>{
 it('refuses unparsable previous timestamp',()=>expect(detectHoldingsAlerts({holdings:['AAA'],previous:[snap('not-a-date','bullish')],current:[snap('2026-11-13T14:00:00Z','bearish')]})).toEqual([]));
 it('refuses absent current quality',()=>expect(detectHoldingsAlerts({holdings:['AAA'],previous:[snap('2026-11-12T14:00:00Z','bullish')],current:[snap('2026-11-13T14:00:00Z','bearish',{dataQualityScore:undefined})]})).toEqual([]));
 it('does not let an unparsable duplicate suppress a valid current snapshot',()=>expect(detectHoldingsAlerts({holdings:['AAA'],previous:[snap('2026-11-12T14:00:00Z','bullish')],current:[snap('bad-date','neutral'),snap('2026-11-13T14:00:00Z','bearish')]})).toHaveLength(1));
});
