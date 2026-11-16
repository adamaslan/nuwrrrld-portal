import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const m=vi.hoisted(()=>({coverage:vi.fn(),log:vi.fn()}));
vi.mock('@/lib/db',()=>({default:()=>{throw new Error('No live DB allowed')}}));
vi.mock('@/lib/ticker-cards-db',()=>({coverageForDate:vi.fn(),coverageForUniverseAndDate:m.coverage,latestCardBarDate:vi.fn(),listActiveTickers:vi.fn(),upsertCards:vi.fn(),upsertUniverse:vi.fn()}));
vi.mock('@/lib/pipeline-run-log-db',()=>({logPipelineRun:m.log}));
const {POST}=await import('@/app/api/pipeline/hydrate-universe/route');
const req=()=>new NextRequest('https://test.invalid/api/pipeline/hydrate-universe',{method:'POST',headers:{authorization:'Bearer test-only','content-type':'application/json'},body:JSON.stringify({source:'fixture',barDate:'2026-11-13',runId:'fixture',complete:true,items:[{subject:'A:t1',model:null,outcome:'ok'}],summary:{total:1}})});
describe('hydration finalization independently checks universe',()=>{
 beforeEach(()=>{vi.clearAllMocks();process.env.PORTAL_PUSH_SECRET='test-only';m.log.mockResolvedValue(true);m.coverage.mockResolvedValue({expected:100,filled:99,missing:['OMITTED'],missingCount:1,staleCount:1,queryFailed:false});});
 it('clean supplied items cannot hide an omitted active ticker',async()=>{const body=await(await POST(req())).json();expect(body.status).toBe('partial');expect(m.coverage).toHaveBeenCalledWith('stock','2026-11-13');expect(m.log).toHaveBeenCalledWith(expect.objectContaining({status:'partial',coverage:expect.objectContaining({expected:100,filled:99}),summary:expect.objectContaining({batchStatus:'ok',batchCoverage:{expected:1,filled:1},coverageScope:'current-active-tickers-any-horizon-at-bar-date'})}));});
 it('unknown independent coverage fails instead of reporting100%',async()=>{m.coverage.mockResolvedValue({expected:0,filled:0,missing:[],missingCount:0,staleCount:0,queryFailed:true});expect((await(await POST(req())).json()).status).toBe('fail');});
});
