import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';
import type { AffectedSite } from '../types.js';
import { applyRename } from './rename.js';
import { applyRenamesToProject } from './apply.js';

// Hermetic Phase-4a tests. We build the ts-morph Project entirely in-memory from
// source strings so there is no dependency on the installed `stripe` types or an
// on-disk fixture. `DemoCharge`/`DemoCustomer` are local interfaces whose names
// the Phase-2 resolver recognises as Stripe-like ("charge"/"customer").

/** Source exercising the target rename AND a same-named decoy on another type. */
const SOURCE = `
interface DemoCharge {
  card: { name: string | null; last4: string };
  amount: number;
}

interface DemoCustomer {
  name: string | null;
  email: string;
}

export function build(charge: DemoCharge, customer: DemoCustomer): string {
  const holder = charge.card.name ?? 'unknown';   // TARGET site #1
  const holder2 = charge.card.name;               // TARGET site #2
  const who = customer.name ?? 'anon';            // DECOY: DemoCustomer.name
  const tail = charge.card.last4;                 // sibling, must stay
  return \`\${holder}\${holder2}\${who}\${tail}\`;
}
`.trimStart();

/** The rename under test: DemoCharge.card.name -> cardholder_name. */
const renameSite: AffectedSite = {
  change: {
    kind: 'field_rename',
    path: 'DemoCharge.card.name',
    from: 'name',
    to: 'cardholder_name',
  },
  locations: [],
};

function inMemoryProject(fileName = 'src/charge.ts', source = SOURCE): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  project.createSourceFile(fileName, source);
  return project;
}

describe('applyRename', () => {
  it('renames the property at EVERY matching site', () => {
    const project = inMemoryProject();
    const edited = applyRename(project, renameSite);

    expect(edited).toHaveLength(2);

    const text = project.getSourceFileOrThrow('src/charge.ts').getFullText();
    expect(text).toContain('charge.card.cardholder_name ?? ');
    expect(text).toContain('charge.card.cardholder_name;');
    // No original `charge.card.name` access survives.
    expect(text).not.toMatch(/charge\.card\.name\b/);
  });

  it('PRECISION: leaves an unrelated .name on a different type untouched (decoy)', () => {
    const project = inMemoryProject();
    applyRename(project, renameSite);

    const text = project.getSourceFileOrThrow('src/charge.ts').getFullText();
    // The decoy DemoCustomer.name must be preserved verbatim.
    expect(text).toContain('customer.name ?? ');
    expect(text).not.toContain('customer.cardholder_name');
    // The sibling leaf on the SAME type must also be preserved.
    expect(text).toContain('charge.card.last4');
  });

  it('is a no-op for a non-rename change', () => {
    const project = inMemoryProject();
    const removed: AffectedSite = {
      change: { kind: 'field_removed', path: 'DemoCharge.card.name' },
      locations: [],
    };
    expect(applyRename(project, removed)).toHaveLength(0);
    expect(project.getSourceFileOrThrow('src/charge.ts').getFullText()).toContain('charge.card.name');
  });
});

describe('applyRenamesToProject (diff)', () => {
  it('produces a unified diff with the -name / +cardholder_name lines, touching only changed files', () => {
    const project = inMemoryProject();
    // A second, unaffected file must NOT appear in the diff.
    project.createSourceFile(
      'src/other.ts',
      'export const greeting = "hello world";\n',
    );

    const result = applyRenamesToProject(project, [renameSite]);

    expect(result.siteCount).toBe(2);
    expect(result.changedFiles).toHaveLength(1);
    expect(result.changedFiles[0]).toContain('charge.ts');

    // Removed lines carry the old name, added lines carry the new name.
    expect(result.diff).toMatch(/^-.*charge\.card\.name/m);
    expect(result.diff).toMatch(/^\+.*charge\.card\.cardholder_name/m);
    // The untouched file is absent from the diff.
    expect(result.diff).not.toContain('other.ts');
  });
});
