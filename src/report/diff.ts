import { createTwoFilesPatch } from 'diff';

// Shared patch renderer for every codemod pass (rename, model-id, param, llm).
//
// The `diff` package's `createTwoFilesPatch` emits SVN-style headers:
//
//   Index: src/agents.ts
//   ===================================================================
//   --- src/agents.ts
//   +++ src/agents.ts
//
// A plain `git apply` (which defaults to -p1) can't apply that — it fails with
// "No such file or directory" because the paths have no a/ b/ prefixes. Since
// the emitted diff IS the whole deliverable, we normalize to standard git patch
// headers so `mendr fix-llm repo > fix.patch && git apply fix.patch` just works.

/**
 * Render a single file's change as a standard git unified patch:
 *
 *   diff --git a/<path> b/<path>
 *   --- a/<path>
 *   +++ b/<path>
 *   @@ ... @@
 *
 * `relPath` should already be repo-relative with forward slashes. Returns the
 * patch text (no trailing coercion); callers join multiple files with '\n'.
 */
export function gitUnifiedPatch(relPath: string, before: string, after: string): string {
  const p = relPath.replace(/\\/g, '/');
  const raw = createTwoFilesPatch(`a/${p}`, `b/${p}`, before, after, '', '', { context: 3 });

  // Drop the leading `Index:` + `===...` lines the `diff` lib prepends and swap
  // in a real `diff --git` header, keeping everything from the first `--- ` on.
  const lines = raw.split('\n');
  const bodyStart = lines.findIndex((l) => l.startsWith('--- '));
  const body = bodyStart >= 0 ? lines.slice(bodyStart).join('\n') : raw;
  return `diff --git a/${p} b/${p}\n${body}`;
}
