import {it,expect} from 'vitest';
import {leadershipClusterConcentration,reboundParticipationAsymmetry,eventWindowExclusionSensitivity} from '../lib/shared/se1/bar-only-batch-06';
it('keeps empty phase coverage missing instead of NaN',()=>{
 const r=reboundParticipationAsymmetry([],{selloffStart:'2026-01-01',selloffEnd:'2026-01-02',reboundStart:'2026-01-03',reboundEnd:'2026-01-04',cutoff:'2026-01-05',reboundComplete:true});
 expect(r.selloff_coverage).toBeNull();expect(r.rebound_coverage).toBeNull();
});
it.each(['__proto__','constructor','toString'])('counts industry identifier %s without inherited object keys',industry=>{
 const r=leadershipClusterConcentration([{ticker:'AAA',canonicalId:'one',score:1,industry}],{classificationVersion:'synthetic',topN:1});
 expect(r.cluster_counts[industry]).toBe(1);expect(r.cluster_shares[industry]).toBe(1);expect(r.concentration_hhi).toBe(1);
});
it('rejects duplicate setup instants in different timestamp forms',()=>{
 expect(()=>eventWindowExclusionSensitivity([{date:'2026-01-02T10:00:00Z',eligible:true,triggered:true},{date:'2026-01-02T05:00:00-05:00',eligible:true,triggered:false}],[],{cutoff:'2026-01-03',minSampleSize:1,exclusionPolicy:'known-at-cutoff-only'})).toThrow(/unique/);
});
it('compares setup cutoff by instant rather than offset text',()=>{
 expect(()=>eventWindowExclusionSensitivity([{date:'2026-01-02T01:00:00+02:00',eligible:true,triggered:true}],[],{cutoff:'2026-01-01T23:30:00Z',minSampleSize:1,exclusionPolicy:'known-at-cutoff-only'})).not.toThrow();
});
