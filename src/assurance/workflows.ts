import type { WorkflowConfig } from '../config/repoConfig.js';

// WHICH CUSTOMER-FACING FEATURE DOES THIS MIGRATION TOUCH?
//
// A model id is a string in a file. What the team cares about is the feature that file serves:
// "answer a support question", "summarise a ticket". mendr cannot infer that from code without
// guessing, so the team names it in mendr.config.json (`workflows`: a name and the paths its code
// lives in), and this module only joins the two: every changed file to every workflow whose paths
// cover it. A file no workflow covers is said out loud, never silently dropped, because the
// after-deploy check can only watch a feature somebody named.

/** One workflow a migration touches, with the changed files that put it in scope. */
export interface AffectedWorkflow {
  name: string;
  files: string[];
}

export interface WorkflowLinks {
  affected: AffectedWorkflow[];
  /** Changed files no workflow's paths cover. */
  unlinked: string[];
}

/** Join repo-relative changed files to the workflows that own them. */
export function linkWorkflows(workflows: readonly WorkflowConfig[], changedFiles: readonly string[]): WorkflowLinks {
  const affected: AffectedWorkflow[] = [];
  const linked = new Set<string>();
  for (const w of workflows) {
    const files = changedFiles.filter((f) => w.paths.some((p) => matchPath(p, f)));
    if (files.length === 0) continue;
    affected.push({ name: w.name, files });
    for (const f of files) linked.add(f);
  }
  return { affected, unlinked: changedFiles.filter((f) => !linked.has(f)) };
}

/**
 * Does a repo-relative path match a pattern? `**` crosses directories, `*` and `?` do not, and a
 * pattern naming a directory (`src/support` or `src/support/`) covers everything under it.
 */
export function matchPath(pattern: string, path: string): boolean {
  const p = normalize(pattern);
  const f = normalize(path);
  if (!/[*?]/.test(p)) return f === p || f.startsWith(`${p.replace(/\/$/, '')}/`);
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === '*' && p[i + 1] === '*') {
      // `**/` matches zero or more whole directories; a trailing `**` matches the rest.
      if (p[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`).test(f);
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}
