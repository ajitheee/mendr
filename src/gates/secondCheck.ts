import { extname, relative } from 'node:path';
import { Node, ts, type Project } from 'ts-morph';
import type { LlmModelIdDeprecation, LlmParamDeprecation, LlmRegistry } from '../types.js';
import { isVerified, modelIdEntries, modelMatches, paramEntries } from '../usage/llmRegistry.js';
import { findModelIdLiterals, type LiteralMatch } from '../usage/scanLiterals.js';
import { dedupeSwapsByNode } from '../fix/modelId.js';
import { findParamSites, onSwappedCalls, withoutHeldCalls } from '../fix/paramFix.js';
import { applyPyModelIdFixesToSources } from '../python/fixPy.js';
import { collectPythonFiles, readPythonSources, type PySource } from '../python/scanPy.js';
import type { CheckStatus } from './status.js';

// VERIFY TWICE: THE SECOND, INDEPENDENT CHECK (PLAN-30-DAYS.md, P2-F).
//
// The first check is the one the migration sandbox already runs: the patched copy type-checks,
// builds and passes the repository's tests. It answers "does it build?". It cannot answer the two
// questions a reviewer most needs answered before approving a rewrite of their code:
//
//   * IS IT COMPLETE? Did the patch reach every live call the scan said it would?
//   * DID IT TOUCH ONLY WHAT IT SHOULD? Every changed token must be a change a registry rule names.
//
// And it cannot see the failure the registry's parameter rules exist for: a type-check passes on a
// `temperature` the new model rejects with a 400, because the SDK still types the key.
//
// "Twice" means two DIFFERENT checks, not the same one run again. This module reads three things
// and nothing else: the repository as it is on disk, the patched text as plain strings, and the
// registry. It never sees the patch writer's AST, its edit list, or its counts. Concretely:
//
//   1. IN SCOPE. Both versions of each changed file are parsed from their text, and the two syntax
//      trees are walked side by side. Every difference must be one of three registry-named edits:
//      a verified model-id swap at a site the locator calls a live model argument, a parameter key
//      renamed by a param_rename rule, or a property removed by a param_removal rule, where the
//      object's own model matches the rule. Comments must survive unchanged. Whitespace is not
//      compared. This is new code; it shares nothing with the writer.
//   2. COMPLETE. The patched text is loaded into a project read fresh from disk, and the model-id
//      locator is run again. A live model argument that is still swap-eligible is a site the patch
//      missed.
//   3. PARAMETERS SATISFIED. On the same patched project, the parameter locator is run again. A
//      request that still carries a key its model's rule rejects or renames is a rule left unmet.
//
// WHAT IT CANNOT DO, said plainly so nobody reads more into "passed" than this: checks 2 and 3
// re-run mendr's own locators, so a call the locator cannot see at all is invisible here too. This
// check catches a patch that did not do what the locator found; it does not raise the locator's
// recall. And it proves nothing about behaviour: that is the eval gate's job, when there is one.
//
// Deterministic, like everything in the fix and gate path (ARCHITECTURE-NEXT.md, invariant 2).

/** What the second check found wrong, one kind per question it asks. */
export type SecondCheckProblemKind = 'out_of_scope_edit' | 'missed_site' | 'param_rule_unmet';

export interface SecondCheckProblem {
  kind: SecondCheckProblemKind;
  /** Repo-relative, forward slashes. */
  file: string;
  /** 1-based. For an out-of-scope edit, the line in the file before the patch. */
  line: number;
  detail: string;
}

export interface SecondCheckOutcome {
  status: CheckStatus;
  detail?: string;
  problems: SecondCheckProblem[];
}

/** A file the patch writer changed, as plain text. */
export interface PatchedText {
  absPath: string;
  newText: string;
}

export interface SecondCheckInput {
  repoPath: string;
  registry: LlmRegistry;
  /**
   * A TypeScript/JavaScript project loaded from disk independently of the patch writer, with the
   * same files the writer saw. It is mutated in memory (patched text is written into it) and never
   * saved. Required when `tsFiles` is not empty.
   */
  freshTs?: Project;
  tsFiles: readonly PatchedText[];
  pyFiles: readonly PatchedText[];
  /** The writer's own option (`migrate --only`): parameter rules apply only at swapped calls. */
  paramsOnSwappedCallsOnly?: boolean;
}

/** Problem lines shown in a detail string before the rest are counted. */
const DETAIL_PROBLEMS = 3;

export async function runSecondCheck(input: SecondCheckInput): Promise<SecondCheckOutcome> {
  const { tsFiles, pyFiles } = input;
  if (tsFiles.length === 0 && pyFiles.length === 0) {
    return { status: 'not_run', detail: 'nothing was patched, so there was nothing to re-check', problems: [] };
  }
  const problems: SecondCheckProblem[] = [];
  if (tsFiles.length > 0) {
    if (!input.freshTs) throw new Error('runSecondCheck: tsFiles given without a fresh project');
    problems.push(...checkTs(input.freshTs, tsFiles, input));
  }
  if (pyFiles.length > 0) problems.push(...(await checkPy(pyFiles, input)));

  const files = tsFiles.length + pyFiles.length;
  const fileWord = `${files} patched file${files === 1 ? '' : 's'}`;
  if (problems.length === 0) {
    return {
      status: 'passed',
      detail:
        `re-read ${fileWord} independently of the patch: every edit matches a registry rule, ` +
        'no live call the scan found was missed, and no parameter rule is left unmet',
      problems,
    };
  }
  const shown = problems.slice(0, DETAIL_PROBLEMS).map((p) => `${p.file}:${p.line} ${p.detail}`);
  const more = problems.length - shown.length;
  return {
    status: 'failed',
    detail: `${problems.length} problem${problems.length === 1 ? '' : 's'} in ${fileWord}: ${shown.join('; ')}${more > 0 ? `; and ${more} more` : ''}`,
    problems,
  };
}

// --- TypeScript / JavaScript ------------------------------------------------------------------

function checkTs(fresh: Project, files: readonly PatchedText[], input: SecondCheckInput): SecondCheckProblem[] {
  const { repoPath, registry } = input;
  const rel = (abs: string): string => relative(repoPath, abs).replace(/\\/g, '/');
  const problems: SecondCheckProblem[] = [];

  // What the locator says may be swapped, read from the UNPATCHED fresh load: the same predicate
  // the codemod applies (model_arg, a verified entry, a real change), one site per literal. A swap
  // anywhere else is out of scope even when the registry names the pair.
  const eligible = swapEligible(findModelIdLiterals(fresh, registry, repoPath));
  const eligibleAt = new Set(eligible.map((m) => siteKey(m.node.getSourceFile().getFilePath(), m.node.getStart())));

  const swappedAfter: { absPath: string; pos: number }[] = [];
  for (const f of files) {
    const sf = fresh.getSourceFile(f.absPath);
    if (!sf) {
      problems.push({ kind: 'out_of_scope_edit', file: rel(f.absPath), line: 1, detail: 'the patch changed a file the scan never read' });
      continue;
    }
    const scope = compareTrees(f.absPath, sf.getFullText(), f.newText, registry);
    for (const s of scope.swaps) {
      if (!eligibleAt.has(siteKey(sf.getFilePath(), s.beforePos))) {
        scope.problems.push({ line: s.beforeLine, detail: `swapped "${s.from}" where the scan found no live model argument` });
      }
      swappedAfter.push({ absPath: f.absPath, pos: s.afterPos });
    }
    for (const p of scope.problems) problems.push({ kind: 'out_of_scope_edit', file: rel(f.absPath), ...p });
  }

  // Load the patched text into the fresh project, in memory only.
  for (const f of files) fresh.getSourceFile(f.absPath)?.replaceWithText(f.newText);

  // COMPLETE: run the locator again. Anything still swap-eligible is a site the patch missed.
  const after = findModelIdLiterals(fresh, registry, repoPath);
  for (const m of swapEligible(after)) {
    problems.push({
      kind: 'missed_site',
      file: rel(m.location.file),
      line: m.location.line,
      detail: `"${m.value}" is still here; the scan says it should become "${m.deprecation.replacement}"`,
    });
  }

  // PARAMETERS SATISFIED: run the parameter locator again, on the calls the writer is allowed to
  // edit. A held call is left alone by design, and with --only only swapped calls are in scope.
  const held = after.filter((m) => m.position === 'surface_capped');
  let sites = withoutHeldCalls(findParamSites(fresh, registry), held, registry);
  if (input.paramsOnSwappedCallsOnly) {
    const swappedNodes = new Set<Node>();
    for (const s of swappedAfter) {
      const node = fresh.getSourceFile(s.absPath)?.getDescendantAtPos(s.pos);
      if (node && (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node))) swappedNodes.add(node);
    }
    sites = onSwappedCalls(sites, swappedNodes);
  }
  for (const s of sites) {
    problems.push({
      kind: 'param_rule_unmet',
      file: rel(s.location.file),
      line: s.location.line,
      detail:
        s.deprecation.kind === 'param_rename'
          ? `"${s.deprecation.param}" is still sent to ${s.model}, which expects "${s.deprecation.replacement}"`
          : `"${s.deprecation.param}" is still sent to ${s.model}, which rejects it`,
    });
  }
  return problems;
}

function swapEligible(matches: LiteralMatch[]): LiteralMatch[] {
  return dedupeSwapsByNode(
    matches.filter((m) => m.position === 'model_arg' && isVerified(m.deprecation) && m.value !== m.deprecation.replacement),
  );
}

function siteKey(absPath: string, pos: number): string {
  return `${absPath.replace(/\\/g, '/')}#${pos}`;
}

interface TreeComparison {
  problems: { line: number; detail: string }[];
  swaps: { from: string; beforePos: number; beforeLine: number; afterPos: number }[];
}

/**
 * Walk the syntax trees of `before` and `after` side by side and explain every difference by a
 * registry rule. Exported for tests: it is the part of this module with the most rules in it.
 */
export function compareTrees(fileName: string, before: string, after: string, registry: LlmRegistry): TreeComparison {
  const kind = scriptKindOf(fileName);
  const a = ts.createSourceFile(fileName, before, ts.ScriptTarget.Latest, true, kind);
  const b = ts.createSourceFile(fileName, after, ts.ScriptTarget.Latest, true, kind);
  const swaps = new Map<string, string>();
  for (const e of modelIdEntries(registry)) if (isSwappable(e)) swaps.set(`${e.deprecated}\u0000${e.replacement}`, e.deprecated);
  const rules = paramEntries(registry);

  const out: TreeComparison = { problems: [], swaps: [] };
  const lineOf = (n: ts.Node): number => a.getLineAndCharacterOfPosition(n.getStart(a)).line + 1;
  const fail = (n: ts.Node, detail: string): false => {
    out.problems.push({ line: lineOf(n), detail });
    return false;
  };
  const removedLines = new Set<number>();

  const walk = (x: ts.Node, y: ts.Node): boolean => {
    if (x.kind !== y.kind) return fail(x, 'changed code no registry rule describes');

    if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) {
      const to = (y as ts.StringLiteral).text;
      if (x.text === to) return true;
      if (isPropertyName(x)) return explainRename(x, y, x.text, to);
      if (swaps.has(`${x.text}\u0000${to}`)) {
        out.swaps.push({ from: x.text, beforePos: x.getStart(a), beforeLine: lineOf(x), afterPos: y.getStart(b) });
        return true;
      }
      return fail(x, `changed "${x.text}" to "${to}", which no verified registry entry names`);
    }
    if (ts.isIdentifier(x)) {
      const to = (y as ts.Identifier).text;
      if (x.text === to) return true;
      if (isPropertyName(x)) return explainRename(x, y, x.text, to);
      return fail(x, `renamed "${x.text}" to "${to}", which no registry rule names`);
    }
    if (ts.isObjectLiteralExpression(x)) return walkObject(x, y as ts.ObjectLiteralExpression);

    const xs = x.getChildren(a);
    const ys = y.getChildren(b);
    if (xs.length === 0 && ys.length === 0) {
      return x.getText(a) === y.getText(b) || fail(x, `changed "${x.getText(a)}" to "${y.getText(b)}"`);
    }
    if (xs.length !== ys.length) return fail(x, 'added or removed code no registry rule describes');
    for (let i = 0; i < xs.length; i++) if (!walk(xs[i]!, ys[i]!)) return false;
    return true;
  };

  // A renamed key must be a param_rename pair, on an object whose model the rule names.
  const explainRename = (x: ts.Node, y: ts.Node, from: string, to: string): boolean => {
    // The key is the property's name, or sits one level down inside a computed `["…"]` name.
    const prop = y.parent && ts.isComputedPropertyName(y.parent) ? y.parent.parent : y.parent;
    const obj = prop?.parent;
    const model = obj && ts.isObjectLiteralExpression(obj) ? modelOf(obj, b) : undefined;
    const rule = rules.find((r) => r.kind === 'param_rename' && r.param === from && r.replacement === to);
    if (!rule) return fail(x, `renamed "${from}" to "${to}", which no parameter rule names`);
    if (model === undefined) return fail(x, `renamed "${from}" on a request whose model could not be read`);
    if (!modelMatches(model, rule.on_models)) return fail(x, `renamed "${from}" on ${model}, which the rule does not cover`);
    return true;
  };

  // Properties are aligned by name, so a removed property is seen as removed rather than as every
  // later property having changed.
  const walkObject = (x: ts.ObjectLiteralExpression, y: ts.ObjectLiteralExpression): boolean => {
    const xs = x.properties;
    const ys = y.properties;
    let i = 0;
    let j = 0;
    while (i < xs.length || j < ys.length) {
      const px = xs[i];
      const py = ys[j];
      if (px && py && sameSlot(px, py)) {
        if (!walk(px, py)) return false;
        i++;
        j++;
        continue;
      }
      if (px && isRemovable(px, y)) {
        const first = a.getLineAndCharacterOfPosition(px.getStart(a)).line + 1;
        const last = a.getLineAndCharacterOfPosition(px.getEnd()).line + 1;
        for (let l = first; l <= last; l++) removedLines.add(l);
        i++;
        continue;
      }
      return fail(px ?? x, px ? `removed or changed "${propName(px) ?? px.getText(a)}", which no parameter rule names` : 'added a property no registry rule describes');
    }
    return true;
  };

  const sameSlot = (px: ts.ObjectLiteralElementLike, py: ts.ObjectLiteralElementLike): boolean => {
    if (px.kind !== py.kind) return false;
    const nx = propName(px);
    const ny = propName(py);
    if (nx === ny) return true;
    return nx !== undefined && ny !== undefined && rules.some((r) => r.kind === 'param_rename' && r.param === nx && r.replacement === ny);
  };

  // A property may disappear only when a param_removal rule names it for this object's model.
  const isRemovable = (px: ts.ObjectLiteralElementLike, objAfter: ts.ObjectLiteralExpression): boolean => {
    if (!ts.isPropertyAssignment(px)) return false;
    const name = propName(px);
    const model = modelOf(objAfter, b);
    return (
      name !== undefined &&
      model !== undefined &&
      rules.some((r: LlmParamDeprecation) => r.kind === 'param_removal' && r.param === name && modelMatches(model, r.on_models))
    );
  };

  walk(a, b);
  if (out.problems.length === 0) {
    const changed = commentChange(a, b, removedLines);
    if (changed) out.problems.push(changed);
  }
  return out;
}

function isSwappable(e: LlmModelIdDeprecation): boolean {
  return isVerified(e) && e.deprecated !== e.replacement;
}

function scriptKindOf(fileName: string): ts.ScriptKind {
  switch (extname(fileName).toLowerCase()) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

/**
 * Is `n` the name of a `key: value` property, written plainly, quoted, or as a computed string?
 * A shorthand `{ max_tokens }` is not: renaming it changes which variable is sent, not only the key.
 */
function isPropertyName(n: ts.Node): boolean {
  const p = n.parent;
  if (!p) return false;
  if (ts.isComputedPropertyName(p)) return ts.isPropertyAssignment(p.parent) && p.parent.name === p;
  return ts.isPropertyAssignment(p) && p.name === n;
}

function propName(p: ts.ObjectLiteralElementLike): string | undefined {
  const name = p.name;
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const e = name.expression;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  }
  return undefined;
}

/**
 * The model an object literal sends, when it can be read without guessing: `model: '…'`, or a
 * name bound once in the same file to a literal, seen through parentheses, `!`, `as string` and
 * `as const` (the wrappers the codemod reads through). Anything else is undefined, and an edit that
 * depends on it is out of scope: this check does not take the writer's word for the model.
 */
function modelOf(obj: ts.ObjectLiteralExpression, sf: ts.SourceFile): string | undefined {
  for (const p of obj.properties) {
    if (propName(p) !== 'model') continue;
    if (ts.isPropertyAssignment(p)) return literalValue(p.initializer, sf);
    if (ts.isShorthandPropertyAssignment(p)) return boundLiteral(p.name.text, sf);
    return undefined;
  }
  return undefined;
}

function literalValue(expr: ts.Expression, sf: ts.SourceFile): string | undefined {
  let e = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
    else if (ts.isAsExpression(e) && isTransparentCast(e, sf)) e = e.expression;
    else break;
  }
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isIdentifier(e)) return boundLiteral(e.text, sf);
  return undefined;
}

function isTransparentCast(e: ts.AsExpression, sf: ts.SourceFile): boolean {
  const t = e.type.getText(sf).trim();
  return t === 'string' || t === 'const';
}

/** The literal a name is bound to, when exactly one declaration in the file binds it to one. */
function boundLiteral(name: string, sf: ts.SourceFile): string | undefined {
  const found: string[] = [];
  let ambiguous = false;
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) {
      const v = n.initializer && !ts.isIdentifier(n.initializer) ? literalValue(n.initializer, sf) : undefined;
      if (v === undefined) ambiguous = true;
      else found.push(v);
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return !ambiguous && found.length === 1 ? found[0] : undefined;
}

/**
 * The comments of both versions, in order, must match: a patch has no reason to edit one. A
 * comment on a line whose property was removed may go with it.
 */
function commentChange(a: ts.SourceFile, b: ts.SourceFile, removedLines: ReadonlySet<number>): { line: number; detail: string } | undefined {
  const before = commentsOf(a).filter((c) => !removedLines.has(c.line));
  const gone = new Set(commentsOf(a).filter((c) => removedLines.has(c.line)).map((c) => c.text));
  const after = commentsOf(b).filter((c) => !gone.has(c.text));
  const n = Math.max(before.length, after.length);
  for (let i = 0; i < n; i++) {
    if (before[i]?.text !== after[i]?.text) {
      return { line: before[i]?.line ?? before[before.length - 1]?.line ?? 1, detail: 'changed a comment' };
    }
  }
  return undefined;
}

function commentsOf(sf: ts.SourceFile): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, sf.languageVariant, sf.getFullText());
  for (let t = scanner.scan(); t !== ts.SyntaxKind.EndOfFileToken; t = scanner.scan()) {
    if (t === ts.SyntaxKind.SingleLineCommentTrivia || t === ts.SyntaxKind.MultiLineCommentTrivia) {
      out.push({ text: scanner.getTokenText(), line: sf.getLineAndCharacterOfPosition(scanner.getTokenStart()).line + 1 });
    }
  }
  return out;
}

// --- Python ---------------------------------------------------------------------------------------
//
// mendr's Python codemod only swaps model ids inside string literals; it never edits parameters.
// So a Python patch is in scope when every changed line differs from the original only in string
// literals that a verified swap names, on a line the locator found swap-eligible, and complete
// when running the Python locator over the patched sources finds nothing left to swap.

async function checkPy(files: readonly PatchedText[], input: SecondCheckInput): Promise<SecondCheckProblem[]> {
  const { repoPath, registry } = input;
  const rel = (abs: string): string => relative(repoPath, abs).replace(/\\/g, '/');
  const problems: SecondCheckProblem[] = [];

  // Read the repository's Python again, from disk.
  const originals = readPythonSources(collectPythonFiles(repoPath));
  const byPath = new Map(originals.map((s) => [norm(s.path), s.text]));

  const planned = await applyPyModelIdFixesToSources(originals, registry, repoPath);
  const eligibleLines = new Set(planned.swapMatches.map((m) => `${norm(m.location.file)}#${m.location.line}`));

  for (const f of files) {
    const before = byPath.get(norm(f.absPath));
    if (before === undefined) {
      problems.push({ kind: 'out_of_scope_edit', file: rel(f.absPath), line: 1, detail: 'the patch changed a file the scan never read' });
      continue;
    }
    for (const p of compareLinesPy(before, f.newText, registry)) {
      if (p.swapped && eligibleLines.has(`${norm(f.absPath)}#${p.line}`)) continue;
      problems.push({
        kind: 'out_of_scope_edit',
        file: rel(f.absPath),
        line: p.line,
        detail: p.swapped ? 'swapped a model id where the scan found no live model argument' : p.detail,
      });
    }
  }

  const patchedByPath = new Map(files.map((f) => [norm(f.absPath), f.newText]));
  const patched: PySource[] = originals.map((s) => ({ path: s.path, text: patchedByPath.get(norm(s.path)) ?? s.text }));
  const again = await applyPyModelIdFixesToSources(patched, registry, repoPath);
  for (const m of again.swapMatches) {
    problems.push({
      kind: 'missed_site',
      file: rel(m.location.file),
      line: m.location.line,
      detail: `"${m.value}" is still here; the scan says it should become "${m.deprecation.replacement}"`,
    });
  }
  return problems;
}

function norm(p: string): string {
  return p.replace(/\\/g, '/');
}

/** A Python string literal with an optional prefix (r, b, u, f and pairs). Triple quotes are not split. */
const PY_STRING = /([rRbBuUfF]{0,2})('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*")/g;

/**
 * Line-by-line, the only difference allowed is inside string literals, and each changed literal
 * must be a verified swap pair. `swapped` lines still need a locator check by the caller. Exported
 * for tests.
 */
export function compareLinesPy(
  before: string,
  after: string,
  registry: LlmRegistry,
): { line: number; swapped: boolean; detail: string }[] {
  const swaps = new Set<string>();
  for (const e of modelIdEntries(registry)) if (isSwappable(e)) swaps.add(`${e.deprecated}\u0000${e.replacement}`);
  const xs = before.split('\n');
  const ys = after.split('\n');
  if (xs.length !== ys.length) {
    return [{ line: 1, swapped: false, detail: 'added or removed lines; a model-id swap only changes text inside a line' }];
  }
  const out: { line: number; swapped: boolean; detail: string }[] = [];
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] === ys[i]) continue;
    const verdict = explainLine(xs[i]!, ys[i]!, swaps);
    out.push({ line: i + 1, swapped: verdict === 'swap', detail: verdict === 'swap' ? '' : verdict });
  }
  return out;
}

function explainLine(x: string, y: string, swaps: ReadonlySet<string>): 'swap' | string {
  const sx = splitStrings(x);
  const sy = splitStrings(y);
  if (sx.length !== sy.length) return 'changed code outside a string literal';
  for (let i = 0; i < sx.length; i++) {
    const p = sx[i]!;
    const q = sy[i]!;
    if (p.code !== q.code) return 'changed code outside a string literal';
    if (p.code) {
      if (p.text !== q.text) return 'changed code outside a string literal';
      continue;
    }
    if (p.text === q.text) continue;
    if (p.prefix !== q.prefix || p.quote !== q.quote) return 'changed how a string is written';
    if (!swaps.has(`${p.body}\u0000${q.body}`)) return `changed "${p.body}" to "${q.body}", which no verified registry entry names`;
  }
  return 'swap';
}

interface Segment {
  code: boolean;
  text: string;
  prefix?: string;
  quote?: string;
  body?: string;
}

function splitStrings(line: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of line.matchAll(PY_STRING)) {
    const start = m.index ?? 0;
    if (start > last) out.push({ code: true, text: line.slice(last, start) });
    const lit = m[2]!;
    out.push({ code: false, text: m[0], prefix: m[1] ?? '', quote: lit[0]!, body: lit.slice(1, -1) });
    last = start + m[0].length;
  }
  if (last < line.length) out.push({ code: true, text: line.slice(last) });
  return out;
}
