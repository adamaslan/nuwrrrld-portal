import { describe, expect, it } from 'vitest';
import { freezeJudgeContext, readFrozenJudgeContext } from '@/lib/judge-frozen-context';
import { evaluateGoldGate } from '@/lib/eval-judge';
describe('frozen author context boundary', () => {
  it('round trips exact brief and actual model without consulting current data', () => {
    const context = freezeJudgeContext('frozen C1: price100\n', 'actual-model-a');
    expect(readFrozenJudgeContext({ validatorFlags: [], judgeContext: context })).toEqual(context);
  });
  it('fails closed for historical, malformed, oversized or validator-rejected context', () => {
    for (const raw of [{}, { validatorFlags: [] }, {validatorFlags:['fabricated'], judgeContext:freezeJudgeContext('brief','a')}, {validatorFlags:[],judgeContext:{version:2,brief:'b',authorModel:'a'}}, {validatorFlags:[],judgeContext:{version:1,brief:'x'.repeat(100001),authorModel:'a'}}]) expect(readFrozenJudgeContext(raw)).toBeNull();
  });
  it('one good result plus two missing responses fails at one third, not100%', () => {
    const results = [{id:'a',goldTotal:5,judgeTotal:5,agrees:true}, {id:'b',goldTotal:5,judgeTotal:null,agrees:false},{id:'c',goldTotal:5,judgeTotal:null,agrees:false}];
    expect(evaluateGoldGate(results)).toMatchObject({passed:false,agreementRate:1/3});
  });
});
