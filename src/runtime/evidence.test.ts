import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  foldObservations,
  inferProvider,
  loadRuntimeEvidenceFile,
  parseCsv,
  toObservation,
} from './evidence.js';

const dir = mkdtempSync(join(tmpdir(), 'mendr-runtime-'));
const write = (name: string, text: string): string => {
  const p = join(dir, name);
  writeFileSync(p, text, 'utf8');
  return p;
};

describe('toObservation — reads only the fields we are allowed to read', () => {
  it('normalizes a fine-tuned id to its base while keeping the raw value', () => {
    const o = toObservation({ model: 'ft:gpt-4:acme::abc', requests: 12 });
    expect(o?.model).toBe('gpt-4');
    expect(o?.observed).toBe('ft:gpt-4:acme::abc');
  });

  it('accepts OTel gen_ai.* attribute names', () => {
    const o = toObservation({
      'gen_ai.system': 'openai',
      'gen_ai.request.model': 'gpt-4',
      'service.name': 'customer-support',
      'deployment.environment': 'production',
      timestamp: '2026-08-29',
      requests: 500,
    });
    expect(o?.provider).toBe('openai');
    expect(o?.model).toBe('gpt-4');
    expect(o?.service).toBe('customer-support');
    expect(o?.environment).toBe('production');
    expect(o?.lastSeen).toBe('2026-08-29');
    expect(o?.requests).toBe(500);
  });

  it('infers the provider when the source did not say', () => {
    expect(inferProvider('gpt-4')).toBe('openai');
    expect(inferProvider('claude-3-opus-20240229')).toBe('anthropic');
    expect(inferProvider('gemini-1.5-pro')).toBe('google');
    expect(inferProvider('llama-3')).toBe('unknown');
  });

  it('counts an HTTP 5xx / "error" status as a failure', () => {
    expect(toObservation({ model: 'gpt-4', status: '500' })?.failures).toBe(1);
    expect(toObservation({ model: 'gpt-4', status: 'error' })?.failures).toBe(1);
    expect(toObservation({ model: 'gpt-4', status: '200' })?.failures).toBe(0);
  });

  it('treats a single log line with no count as one request', () => {
    expect(toObservation({ model: 'gpt-4' })?.requests).toBe(1);
  });

  it('returns null for a row that names no model', () => {
    expect(toObservation({ service: 'api', requests: 5 })).toBeNull();
  });
});

describe('foldObservations — merges by model, keeps the latest sighting', () => {
  it('sums volume and keeps the most recent lastSeen', () => {
    const [o] = foldObservations([
      { provider: 'openai', model: 'gpt-4', observed: 'gpt-4', service: 'a', environment: 'prod', lastSeen: '2026-08-01', requests: 10, requestsReported: true, failures: 1, costUsd: null },
      { provider: 'openai', model: 'gpt-4', observed: 'gpt-4', service: null, environment: null, lastSeen: '2026-08-29', requests: 5, requestsReported: true, failures: 0, costUsd: null },
    ]);
    expect(o.requests).toBe(15);
    expect(o.failures).toBe(1);
    expect(o.lastSeen).toBe('2026-08-29');
    expect(o.service).toBe('a');
  });
});

describe('parseCsv', () => {
  it('handles quoted fields with embedded commas', () => {
    const rows = parseCsv('model,note\n"gpt-4","a, b"\n');
    expect(rows).toEqual([{ model: 'gpt-4', note: 'a, b' }]);
  });
});

describe('loadRuntimeEvidenceFile — the key-free runtime paths', () => {
  it('reads a sanitized CSV export (Option 2 / gateway logs)', () => {
    const p = write('g.csv', 'service,environment,provider,model,requests,errors,last_seen\ncustomer-support,production,openai,gpt-4,18342,7,2026-08-29\n');
    const ev = loadRuntimeEvidenceFile(p, 'gateway_logs');
    expect(ev.connected).toBe(true);
    expect(ev.source).toBe('gateway_logs');
    expect(ev.observations[0]).toMatchObject({
      model: 'gpt-4', provider: 'openai', service: 'customer-support',
      environment: 'production', requests: 18342, failures: 7, lastSeen: '2026-08-29',
    });
  });

  it('reads an OTel resourceSpans envelope with KeyValue attribute bags', () => {
    const p = write('o.json', JSON.stringify({
      resourceSpans: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'svc' } }] },
        attributes: { 'gen_ai.system': 'openai', 'gen_ai.request.model': 'gpt-4', requests: 3 },
      }],
    }));
    const ev = loadRuntimeEvidenceFile(p, 'otel');
    expect(ev.observations[0]).toMatchObject({ model: 'gpt-4', service: 'svc', requests: 3 });
  });

  it('reads NDJSON', () => {
    const p = write('n.ndjson', '{"model":"gpt-4","requests":2}\n{"model":"gpt-4","requests":3}\n');
    const ev = loadRuntimeEvidenceFile(p);
    expect(ev.observations[0].requests).toBe(5);
  });

  it('always discloses that the source covers only what it records', () => {
    const p = write('d.csv', 'model,requests\ngpt-4,1\n');
    expect(loadRuntimeEvidenceFile(p).notes.join(' ')).toContain('NOT proven unused');
  });

  it('throws a helpful error when no model column exists', () => {
    const p = write('bad.csv', 'service,requests\napi,5\n');
    expect(() => loadRuntimeEvidenceFile(p)).toThrow(/no model observations/);
  });
});
