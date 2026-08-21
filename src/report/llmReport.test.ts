import { describe, it, expect } from 'vitest';
import {
  formatCatalogLine,
  formatDataFileGroupLine,
  formatDataHitLine,
  formatGateSummary,
  formatUsageUnverifiedLine,
  groupDataFindingsByFile,
  isCatalogLike,
  purposePhrase,
  replacementFamily,
  swapLabel,
  type DataFindingView,
} from './llmReport.js';

// The report-shaping layer: a 100+ finding scan must collapse to one line per
// file (the acceptance bar is a ~30-line report on real repos), while --verbose
// keeps every hit reachable with purpose-aware language.

function hit(file: string, value: string, purpose?: DataFindingView['purpose']): DataFindingView {
  return { file, value, replacement: 'x-replacement', line: 1, column: 1, purpose };
}

describe('groupDataFindingsByFile', () => {
  it('collapses per-file with id occurrence counts, preserving first-sighting order', () => {
    const groups = groupDataFindingsByFile([
      hit('lib/limits.ts', 'gpt-4'),
      hit('lib/limits.ts', 'gpt-4'),
      hit('lib/limits.ts', 'gemini-pro'),
      hit('app/other.ts', 'o1-mini'),
    ]);

    expect(groups.map((g) => g.file)).toEqual(['lib/limits.ts', 'app/other.ts']);
    expect(groups[0].hits).toBe(3);
    expect([...groups[0].idCounts.entries()]).toEqual([
      ['gpt-4', 2],
      ['gemini-pro', 1],
    ]);
    expect(groups[1].hits).toBe(1);
  });

  it('counts comparison-purpose hits separately (they may gate logic)', () => {
    const groups = groupDataFindingsByFile([
      hit('app/gate.ts', 'gpt-4', 'comparison'),
      hit('app/gate.ts', 'gpt-4', 'list_entry'),
    ]);
    expect(groups[0].comparisons).toBe(1);
  });
});

describe('catalog heuristic', () => {
  it('fires on >10 distinct deprecated ids regardless of filename', () => {
    expect(isCatalogLike('src/anything.ts', 11)).toBe(true);
    expect(isCatalogLike('src/anything.ts', 10)).toBe(false);
  });

  it('fires on catalog-suggesting basenames regardless of id count', () => {
    for (const f of [
      'lib/prices.ts',
      'app/models.py',
      'app/constant.ts',
      'lib/chat-setting-limits.ts',
      'src/openai-llm-list.ts',
      'app/masks.ts',
    ]) {
      expect(isCatalogLike(f, 1), f).toBe(true);
    }
    expect(isCatalogLike('src/routes/chat.ts', 1)).toBe(false);
  });

  it('matches the basename only, never the directory path', () => {
    // A file INSIDE a models/ directory is not itself catalog-named.
    expect(isCatalogLike('models/handler.ts', 1)).toBe(false);
  });
});

describe('formatDataFileGroupLine', () => {
  it('renders the one-line-per-file summary with id counts and a cap', () => {
    const groups = groupDataFindingsByFile([
      hit('lib/limits.ts', 'gpt-4'),
      hit('lib/limits.ts', 'gpt-4'),
      hit('lib/limits.ts', 'gemini-pro'),
      hit('lib/limits.ts', 'o1-mini'),
      hit('lib/limits.ts', 'gpt-4-32k'),
      hit('lib/limits.ts', 'text-davinci-003'),
    ]);
    const line = formatDataFileGroupLine(groups[0]);

    expect(line).toContain('lib/limits.ts -- 6 hits across 5 model ids');
    expect(line).toContain('gpt-4 x2');
    // Only the first 4 ids are spelled out; the rest collapse to "...".
    expect(line).toContain('...');
    expect(line).not.toContain('text-davinci-003');
    // "limits" basename -> catalog label.
    expect(line).toContain('[looks like a model catalog]');
  });

  it('flags runtime comparisons on the collapsed line', () => {
    const groups = groupDataFindingsByFile([hit('app/gate.ts', 'gpt-4', 'comparison')]);
    expect(formatDataFileGroupLine(groups[0])).toContain('1 runtime comparison (may gate logic, review)');
  });
});

describe('purpose-aware hit language (--verbose)', () => {
  it('maps each purpose to its phrase', () => {
    expect(purposePhrase('comparison')).toBe('in a runtime comparison (== / ===)');
    expect(purposePhrase('lookup_key')).toBe('used as a lookup key');
    expect(purposePhrase('list_entry')).toBe('used as a list entry');
    expect(purposePhrase('catalog_entry')).toBe('used as a config/catalog entry');
    expect(purposePhrase('generic')).toBe('used as data');
    expect(purposePhrase(undefined)).toBe('used as data');
  });

  it('a guard-supplied reason replaces the generic review advice', () => {
    const line = formatDataHitLine({
      file: 'src/chat.ts',
      value: 'gpt-4',
      replacement: 'gpt-5.6-sol',
      line: 3,
      column: 9,
      purpose: 'generic',
      reason: 'type-cast masks the model-id union -- review manually',
    });
    expect(line).toContain('src/chat.ts:3:9');
    expect(line).toContain('type-cast masks the model-id union');
    expect(line).not.toContain('would map to');
  });
});

describe('swapLabel (lifecycle attaches to the SOURCE id)', () => {
  it('attaches a shutdown date to the deprecated id, not the replacement', () => {
    expect(
      swapLabel({
        provider: 'openai',
        kind: 'model_id',
        deprecated: 'gpt-4',
        replacement: 'gpt-5.6-sol',
        status: 'deprecated',
        shutdownDate: '2026-10-23',
      }),
    ).toBe('"gpt-4" (shuts down 2026-10-23) -> "gpt-5.6-sol"');
  });

  it('marks a retired source id', () => {
    expect(
      swapLabel({
        provider: 'google',
        kind: 'model_id',
        deprecated: 'gemini-2.0-flash',
        replacement: 'gemini-flash-latest',
        status: 'retired',
      }),
    ).toBe('"gemini-2.0-flash" (retired) -> "gemini-flash-latest"');
  });

  it('uses a plain arrow when the lifecycle is unknown', () => {
    expect(
      swapLabel({
        provider: 'openai',
        kind: 'model_id',
        deprecated: 'o1-mini',
        replacement: 'o4-mini',
      }),
    ).toBe('"o1-mini" -> "o4-mini"');
  });
});

describe('formatCatalogLine (annotated model-catalog files)', () => {
  it('renders the known-migration-catalog line', () => {
    expect(formatCatalogLine({ file: 'src/registry/oracles.ts', ids: ['gpt-4', 'o1-mini'] })).toBe(
      'src/registry/oracles.ts -- known migration catalog: 2 deprecated ids ' +
        '(expected registry content, no action)',
    );
  });
});

describe('formatUsageUnverifiedLine (sink-rule demotions)', () => {
  it('carries the exact manual-review phrase and the location', () => {
    const line = formatUsageUnverifiedLine({
      file: 'sim/simulator.py',
      value: 'gpt-4',
      replacement: 'gpt-5.6-sol',
      line: 2,
      column: 13,
    });
    expect(line).toContain('sim/simulator.py:2:13');
    expect(line).toContain(
      'model-like data assignment, replacement known, usage purpose uncertain, manual review required',
    );
    expect(line).toContain('never auto-applied');
  });
});

describe('formatGateSummary (code vs behavioral verification)', () => {
  // The whole point of the two-group summary: a reader must not be able to
  // mistake "type-check + tests passed" for "the new model behaves the same".
  const TS_FACTS = {
    usageClassification: 'call-site',
    typeCheck: 'pass (no new errors; 3 pre-existing ignored)',
    tests: 'pass (npm test, 42 passed, 0 failed)',
  };

  it('names both groups, and marks the behavioral one NOT checked', () => {
    const lines = formatGateSummary(TS_FACTS);
    expect(lines[0]).toBe('Code verification (what mendr checked):');
    expect(lines).toContain('Behavioral verification (NOT checked):');
    const text = lines.join('\n');
    expect(text).toMatch(/output quality, latency, cost and response/);
    // Code claims come FIRST, the disclaimer last — a disclaimer above the
    // evidence reads as boilerplate and gets skipped.
    expect(text.indexOf('type-check')).toBeLessThan(text.indexOf('Behavioral verification'));
  });

  it('keeps the measurable test counts verbatim', () => {
    expect(formatGateSummary(TS_FACTS).join('\n')).toMatch(
      /^ {2}tests: +pass \(npm test, 42 passed, 0 failed\)$/m,
    );
  });

  it('lists only the gates that exist for the language', () => {
    expect(formatGateSummary(TS_FACTS).join('\n')).toContain('type-check:');

    // Python has no compiler: a syntax re-parse plus an explicit "not
    // configured" static-type row, never a silently-passed type gate.
    const py = formatGateSummary({
      usageClassification: 'verified-sink',
      syntax: 'pass',
      staticTypeGate: 'not configured or not detected',
      tests: 'not run (no supported test command detected)',
    }).join('\n');
    expect(py).not.toContain('type-check:');
    expect(py).toMatch(/^ {2}syntax: +pass$/m);
    expect(py).toMatch(/^ {2}static type gate: +not configured or not detected$/m);
    expect(py).toMatch(/^ {2}usage classification: +verified-sink$/m);
  });

  it('always claims the mapping was verified against live catalogs', () => {
    expect(formatGateSummary(TS_FACTS).join('\n')).toMatch(
      /^ {2}replacement mapping: +verified against live catalogs$/m,
    );
  });

  it('aligns every gate value in one column, so the rows read as one table', () => {
    const lines = formatGateSummary(TS_FACTS);
    const gateRows = lines.slice(1, lines.indexOf('Behavioral verification (NOT checked):'));
    expect(gateRows).toHaveLength(4);
    // Every row's value starts at the same column (labels padded to one width).
    const valueColumns = new Set(gateRows.map((row) => /^ {2}[\w -]+: +/.exec(row)![0].length));
    expect(valueColumns.size).toBe(1);
  });
});

describe('replacementFamily (mixed-target warning)', () => {
  it('cuts at the first digit run', () => {
    expect(replacementFamily('gpt-4.1')).toBe('gpt-4');
    expect(replacementFamily('gpt-5.6-sol')).toBe('gpt-5');
    expect(replacementFamily('claude-opus-4-8')).toBe('claude-opus-4');
  });

  it('an id with no digits is its own family', () => {
    expect(replacementFamily('gemini-flash-latest')).toBe('gemini-flash-latest');
  });
});
