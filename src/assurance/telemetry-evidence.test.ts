import { describe, expect, it } from 'vitest';
import { toCallSample, toObservation } from '../runtime/evidence.js';
import { windowsFromTelemetry } from './telemetry.js';
import { judgeRollout } from './rollout.js';

const deployedAt = new Date('2026-10-20T12:00:00Z');
function rows(extra: Record<string, unknown> = {}) {
  return [-1,1].flatMap(side => Array.from({length:120},(_,i)=>({
    timestamp:new Date(deployedAt.getTime()+side*(i+1)*1000).toISOString(),
    model:side<0?'o4-mini':'gpt-5.6-terra',requests:1,...extra,
  })));
}
const summarize = (input: ReturnType<typeof rows>) => windowsFromTelemetry(input.map(toCallSample),{workflow:'Synthetic',deployedAt});
describe('telemetry keeps missing evidence unknown',()=>{
  it('cannot turn an export without outcomes into a healthy rollout',()=>{
    const r=summarize(rows());
    expect(r.input.before.errorRate).toBeUndefined();
    expect(r.input.after.errorRate).toBeUndefined();
    expect(judgeRollout(r.input,undefined).verdict).toBe('inconclusive');
  });
  it('holds missing, malformed and partial failure evidence',()=>{
    for(const value of ['pending','200not-a-code','',null]) {
      const r=summarize(rows({status:value}));
      expect(judgeRollout(r.input,undefined).verdict).toBe('inconclusive');
    }
    const partial=rows({status:200});delete partial[200].status;
    expect(summarize(partial).input.after.errorRate).toBeUndefined();
    expect(judgeRollout(summarize(rows({failures:'unknown'})).input,undefined).verdict).toBe('inconclusive');
  });
  it('valid failures are regressions; explicit success and explicit zero recover',()=>{
    const unhealthy=rows({status:200});unhealthy.filter((_,i)=>i>=120).forEach(x=>x.status=500);
    expect(judgeRollout(summarize(unhealthy).input,undefined).verdict).toBe('regression');
    for(const fields of [{status:200},{status:'success'},{failures:0}]) {
      expect(judgeRollout(summarize(rows(fields)).input,undefined).verdict).toBe('verified');
    }
  });
  it('does not invent zero cost from malformed values; an actual zero remains measured',()=>{
    for(const cost of ['unknown','12garbage',-1,Infinity]) {
      expect(toCallSample({model:'o4-mini',cost}).costUsd).toBeNull();
      expect(toObservation({model:'o4-mini',cost})?.costUsd).toBeNull();
      expect(toCallSample({model:'o4-mini',latency_ms:cost}).latencyMs).toBeNull();
    }
    expect(toCallSample({model:'o4-mini',cost:0}).costUsd).toBe(0);
    expect(toObservation({model:'o4-mini',cost:'0'})?.costUsd).toBe(0);
    const r=summarize(rows({status:200,cost:'unknown'}));
    expect(r.input.after.costPer1k).toBeUndefined();
  });
});
