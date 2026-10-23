import { it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { autoApplyVerification } from '../usage/llmRegistry.js';
import { runMigration } from './migrate.js';
import type { LlmRegistry } from '../types.js';

// Fail the existing independent-check boundary, not the migration implementation.
const control = vi.hoisted(() => ({ fail: true }));
vi.mock('../gates/secondCheck.js', async importOriginal => {
  const real = await importOriginal<typeof import('../gates/secondCheck.js')>();
  return { ...real, runSecondCheck: async (...args: Parameters<typeof real.runSecondCheck>) => control.fail
    ? { status: 'failed', detail: 'synthetic second-check rejection', problems: [] }
    : real.runSecondCheck(...args) };
});
it('a failed second check cannot verify or write; a real healthy check subsequently recovers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mendr-write-revalidation-'));
  const source = 'import OpenAI from "openai";\nconst client = new OpenAI();\nexport async function ask(){return client.chat.completions.create({model:"gpt-4-0613",messages:[]});}\n';
  const file = join(dir, 'src/app.ts');
  try {
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'node_modules/openai'), { recursive: true });
    writeFileSync(file, source);
    writeFileSync(join(dir, 'package.json'), '{"name":"synthetic"}');
    writeFileSync(join(dir, 'node_modules/openai/package.json'), '{"name":"openai","types":"index.d.ts"}');
    writeFileSync(join(dir, 'node_modules/openai/index.d.ts'), 'declare class OpenAI { chat: { completions: { create(body:{model:string;messages:unknown[]}):Promise<unknown> } } }; export default OpenAI;');
    writeFileSync(join(dir, 'eval.cjs'), 'require("node:assert/strict").ok(true);');
    const registry: LlmRegistry = [{provider:'openai',kind:'model_id',deprecated:'gpt-4-0613',replacement:'gpt-5.6-sol',verification:autoApplyVerification()}];
    const bad=await runMigration(dir,registry,{write:true,evalCommand:'node eval.cjs'});
    expect(bad.verification.typeCheck.status).toBe('passed');
    expect(bad.verification.eval.status).toBe('passed');
    expect(bad.verification.verdict).toBe('failed');
    expect(bad.prReady).toBe(false);
    expect(bad.applied).toEqual([]);
    expect(readFileSync(file,'utf8')).toBe(source);
    control.fail=false;
    const healthy=await runMigration(dir,registry,{write:true,evalCommand:'node eval.cjs'});
    expect(healthy.verification.secondCheck.status).toBe('passed');
    expect(healthy.verification.verdict).toBe('verified');
    expect(healthy.applied).toEqual(['src/app.ts']);
    expect(readFileSync(file,'utf8')).toBe(source.replace('gpt-4-0613','gpt-5.6-sol'));
  } finally { control.fail=true; rmSync(dir,{recursive:true,force:true}); }
},30000);
