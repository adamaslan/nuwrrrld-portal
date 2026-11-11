/** Offline context only. Not a signal vote, recommendation or promoted detector. */
import { createHash } from 'node:crypto';
import { buildFrame } from '../indicators';
import { smaSeries } from '../indicators/ma';
import type { Bar } from '../frame';

export const SCAN_ID = 'se1.trend.ma_distance_atr';
export const SCAN_VERSION = '1.0.0-research';
export interface DatedBar extends Bar { date: string }
export interface DossierInput {
  symbol: string;
  source: string;
  priceBasis: 'split-adjusted-ohlc' | 'raw' | 'unknown';
  bars: readonly DatedBar[];
}
export interface MaDistanceResult {
  scanId: typeof SCAN_ID;
  version: typeof SCAN_VERSION;
  role: 'context';
  promoted: false;
  confluenceWeight: 0;
  symbol: string;
  source: string;
  declaredPriceBasis: DossierInput['priceBasis'];
  basisIndependentlyVerified: false;
  asOf: string;
  inputHash: string;
  barsUsed: number;
  status: 'available' | 'insufficient_history' | 'withheld';
  reason: string | null;
  close: number | null;
  sma50: number | null;
  atr14: number | null;
  distanceAtr: number | null;
  distancePercent: number | null;
}
function day(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
    && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0,10) === s;
}
/** Only bars available at the declared point-in-time boundary enter the formula/hash.
 * Input dates represent completed daily sessions, not intraday observations.
 * Source and basis are caller declarations, never proof of provider/corporate actions.
 */
export function evaluateMaDistance(input: DossierInput, asOf: string): MaDistanceResult {
  if (!day(asOf)) throw new Error('asOf must be a real YYYY-MM-DD date');
  if (Date.parse(asOf) > Math.floor(Date.now()/86400000)*86400000) throw new Error('asOf cannot be a future completed session');
  if (!input || typeof input.symbol !== 'string' || !/^[A-Z0-9.^-]{1,20}$/.test(input.symbol)
    || typeof input.source !== 'string' || !input.source.trim() || input.source.length > 200
    || !['split-adjusted-ohlc','raw','unknown'].includes(input.priceBasis)
    || !Array.isArray(input.bars)) throw new Error('Invalid dossier input/provenance');
  let previous = '';
  for (const b of input.bars) {
    if (!b || !day(b.date) || b.date <= previous) throw new Error('Bars require unique ascending daily dates');
    previous = b.date;
  }
  const bars = input.bars.filter(b => b.date <= asOf);
  const inputHash = createHash('sha256').update(JSON.stringify({scanId:SCAN_ID,version:SCAN_VERSION,symbol:input.symbol, source:input.source,
    priceBasis:input.priceBasis, asOf, bars})).digest('hex');
  const result: MaDistanceResult = {
    scanId:SCAN_ID, version:SCAN_VERSION, role:'context', promoted:false, confluenceWeight:0,
    symbol:input.symbol, source:input.source, declaredPriceBasis:input.priceBasis,
    basisIndependentlyVerified:false, asOf, inputHash, barsUsed:bars.length,
    status:'withheld', reason:null, close:null, sma50:null, atr14:null,
    distanceAtr:null, distancePercent:null,
  };
  const withhold = (reason:string):MaDistanceResult => ({...result,reason});
  if (input.priceBasis !== 'split-adjusted-ohlc') return withhold('unknown_or_raw_price_basis');
  for (const b of bars) {
    if (![b.open,b.high,b.low,b.close,b.volume].every(x => typeof x === 'number' && Number.isFinite(x))
      || Math.min(b.open,b.high,b.low,b.close) <= 0 || b.volume < 0
      || b.low > Math.min(b.open,b.close) || b.high < Math.max(b.open,b.close) || b.low > b.high) {
      return withhold('invalid_ohlcv');
    }
  }
  if (bars.length < 50) return {...result,status:'insufficient_history',reason:'requires_50_completed_bars'};
  const ageDays = (Date.parse(asOf)-Date.parse(bars.at(-1)!.date))/86400000;
  if (ageDays > 7) return withhold('stale_last_bar');
  for (let i=1;i<bars.length;i++) {
    if ((Date.parse(bars[i].date)-Date.parse(bars[i-1].date))/86400000 > 7) return withhold('calendar_gap_over_7_days');
  }
  const frame = buildFrame(bars);
  const close=bars.at(-1)!.close, sma50=smaSeries(frame.close,50).at(-1)!, atr14=frame.atr.at(-1)!;
  if (![sma50,atr14].every(Number.isFinite) || sma50 <= 0 || atr14 <= 0) return withhold('invalid_or_zero_atr');
  const distanceAtr=(close-sma50)/atr14, distancePercent=(close/sma50-1)*100;
  if (![distanceAtr,distancePercent].every(Number.isFinite)) return withhold('nonfinite_formula');
  return {...result,status:'available',close,sma50,atr14,distanceAtr,distancePercent};
}
/** Recompute each prefix, never feed outcome labels or future bars to the detector. */
export function replayMaDistance(input:DossierInput):MaDistanceResult[] {
  return input.bars.map(b => evaluateMaDistance(input,b.date));
}
