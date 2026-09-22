// PLANE 2, SLICE 3 — Python SDK pins in the ROOT requirements*.txt files.
//
// Slice 1 read the root package-lock.json for npm. Python repos got "not read". The teams
// Mendr actually finds retiring model ids in pin their Python dependencies in a root
// requirements.txt, so this reads exactly that, and nothing else.
//
// WHAT IT RESOLVES: a line whose PEP 503-normalised name is one of the four PyPI provider
// SDKs AND whose spec is a single exact `==<version>` (with optional --hash options). The
// version goes through the same resolveSdk `mendr resolve pypi:<name>@<version>` uses.
//
// WHAT IT REFUSES, never guesses: ranges (>=, ~=, !=, ==1.*), exact pins in a version form
// this build does not read, URL and VCS requirements, pins behind an environment marker,
// and an SDK listed more than once in one file. A pin is never called "declared",
// "installed" or "used": a pip-compile file lists transitive pins too, and when its own
// "# via" note names only other packages, the line says so.
//
// WHAT IT ONLY NAMES: -r/-c includes (never followed), editable installs, every line it
// cannot read (paths, URLs, archives, unknown options, over-long lines), unreadable files,
// and the other Python manifests at the root (pyproject.toml, setup.py, uv.lock, ...). When
// any of those exists, a "none" is partial. It FAILS CLOSED: a line pip would treat as a
// requirement but this grammar cannot place is counted, never skipped.
//
// It reads lines the way pip does (pip's req_file.preprocess): Python's splitlines
// separators, backslash continuations that a comment line never extends, and "#" as a
// comment only at the start of a line or after whitespace.
//
// Printed: the SDK's record name, a version parseSdkSpec accepted, an allow-listed file
// name, integers and fixed reasons. Never a spec, URL, index, hash, marker or comment text.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseSdkSpec, resolveSdk, type Resolution } from '../registry/graph.js';
import { SDK_PACKAGES, type SdkReleases } from '../registry/sdkReleases.js';

export interface PinnedSdk {
  /** The SDK, as the release record names it. */
  name: string;
  /** The root file it is listed in (allow-listed), or 'a requirements*.txt file'. */
  file: string;
  /** The exact pinned version, or null when it is not resolved (never printed then). */
  version: string | null;
  resolution: Resolution | null;
  /** resolveSdk's reason verbatim, or the fixed reason it was not resolved. */
  reason: string;
  /** A pip-compile "# via" note names only other packages or constraint files. */
  viaOthersOnly: boolean;
}

export interface PythonReqReport {
  /** How many PyPI SDKs Mendr looks for — the denominator behind "none". */
  checked: number;
  /** Root requirements*.txt files found. */
  filesFound: number;
  /** Of those, how many could not be read (too large, not UTF-8, binary, past the file cap). */
  filesNotRead: number;
  sdks: PinnedSdk[];
  /** -r / -c includes, never followed. */
  includes: number;
  /** -e / --editable installs. */
  editables: number;
  /** Lines pip would read that this grammar cannot place: paths, URLs, archives, unknown options, over-long lines. */
  unreadableLines: number;
  /** Other Python manifests at the root, not read. */
  rootManifestsNotRead: string[];
  /** The reader itself failed; nothing above is known. */
  failed?: boolean;
}

const PYPI_SDKS = SDK_PACKAGES.filter((p) => p.ecosystem === 'pypi').map((p) => p.name);
const pep503 = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, '-');
const SDK_BY_NAME = new Map(PYPI_SDKS.map((n) => [pep503(n), n]));

const REQUIREMENTS = /^requirements.*\.txt$/i;
const PRINTABLE_FILE = /^requirements[A-Za-z0-9._-]{0,64}\.txt$/i;
const OTHER_ROOT_MANIFESTS = ['pyproject.toml', 'setup.py', 'setup.cfg', 'Pipfile', 'uv.lock', 'poetry.lock', 'Pipfile.lock', 'pdm.lock'];
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LINE = 512;
const MAX_FILES = 20;

/** A leading PEP 508 name, optional extras, and the rest of the requirement. */
const REQUIREMENT = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(\[[^\]]*\])?\s*(.*)$/;
/** What may follow a name in a PEP 508 requirement. Anything else is not a named requirement. */
const SPEC_START = /^(?:$|[<>=!~(;@,])/;
/** pip's archive extensions: a requirement ending in one is a file, whatever it looks like. */
const ARCHIVE = /\.(?:whl|zip|tar|tar\.gz|tgz|tar\.bz2|tbz|tar\.xz|txz|tlz|tar\.lz|tar\.lzma)$/i;
/** Options that never name a package (pip's requirements-file option set). Anything else fails closed. */
const HARMLESS_OPTION =
  /^(?:-i|--index-url|--extra-index-url|--no-index|-f|--find-links|--trusted-host|--hash|--pre|--prefer-binary|--only-binary|--no-binary|--require-hashes|--use-feature|--config-settings|--global-option)(?:\s|=|$)|^-[if]\S/;

/**
 * pip reads a requirement as a path or URL, not a name, when its first token has a slash,
 * a drive letter, a scheme, a VCS prefix, or an archive extension (pip's _looks_like_path).
 */
function looksLikePathOrUrl(line: string): boolean {
  const token = line.split(/[\s;@]/, 1)[0]!;
  return (
    /[\\/]/.test(token) ||
    /^[A-Za-z]:/.test(token) ||
    /^[a-z][a-z0-9+.-]*:/i.test(token) ||
    /^(?:git|hg|svn|bzr)\+/i.test(token) ||
    /^[~.]/.test(token) ||
    ARCHIVE.test(token)
  );
}

/** Strict UTF-8, or null: a file that is not text is "not read", never "none". */
function readText(path: string): string | null {
  try {
    if (statSync(path).size > MAX_FILE_BYTES) return null;
    const bytes = readFileSync(path);
    if (bytes.includes(0)) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
}

/** Every separator Python's str.splitlines splits on — pip reads requirement files with it. */
const LINE_BREAKS = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

/**
 * Logical lines as pip builds them: split on everything Python's str.splitlines splits on;
 * a line ending in "\" continues onto the next, but a COMMENT line never continues and ends
 * any continuation in progress (pip's join_lines).
 */
function logicalLines(text: string): string[] {
  const out: string[] = [];
  let pending: string[] = [];
  for (const line of text.split(LINE_BREAKS)) {
    const comment = /^\s*#/.test(line);
    if (!line.endsWith('\\') || comment) {
      if (pending.length > 0) {
        out.push(pending.join('') + (comment ? ` ${line}` : line));
        pending = [];
      } else {
        out.push(line);
      }
    } else {
      pending.push(line.replace(/\\+$/, ''));
    }
  }
  if (pending.length > 0) out.push(pending.join(''));
  return out;
}

/** pip treats "#" as a comment at the start of a line or after whitespace (not inside a URL). */
const stripComment = (line: string): string => line.replace(/(^|\s)#.*$/, '').trim();

/**
 * The entries of a pip-compile / uv "# via" note for the requirement on line `i`: either on
 * the same line ("openai==1.0  # via langchain") or on the comment lines right after it,
 * as one comma-joined line or one entry per line. Null when there is no note.
 */
function viaNote(lines: string[], i: number): string[] | null {
  const split = (s: string): string[] => s.split(',').map((e) => e.trim()).filter(Boolean);
  const inline = /\s#\s*via\s+(.+)$/.exec(lines[i]!);
  if (inline) return split(inline[1]!);
  const m = /^#\s*via\b(.*)$/.exec(lines[i + 1]?.trim() ?? '');
  if (!m) return null;
  const entries = split(m[1]!);
  for (let j = i + 2; j < lines.length; j++) {
    const cont = /^#\s{2,}(\S.*)$/.exec(lines[j]!.trim());
    if (!cont) break;
    entries.push(...split(cont[1]!));
  }
  return entries;
}

/**
 * A note entry that names the project's OWN input, not another package: "-r requirements.in",
 * or "myapp (pyproject.toml)" as pip-compile and `uv pip compile` write it.
 */
const isDirectInput = (entry: string): boolean => /^-r(\s|$)/.test(entry) || /\([^()]+\)$/.test(entry);

/** Read the root requirements*.txt files, or undefined when the root has no Python dependency file at all. */
export function readPinnedRequirements(repoPath: string, releases: SdkReleases | null, now: Date = new Date()): PythonReqReport | undefined {
  let rootNames: string[];
  try {
    rootNames = readdirSync(repoPath, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return undefined;
  }
  const reqFiles = rootNames.filter((n) => REQUIREMENTS.test(n)).sort();
  const rootManifestsNotRead = OTHER_ROOT_MANIFESTS.filter((n) => rootNames.includes(n));
  if (reqFiles.length === 0 && rootManifestsNotRead.length === 0) return undefined;

  const report: PythonReqReport = {
    checked: PYPI_SDKS.length,
    filesFound: reqFiles.length,
    filesNotRead: Math.max(0, reqFiles.length - MAX_FILES),
    sdks: [],
    includes: 0,
    editables: 0,
    unreadableLines: 0,
    rootManifestsNotRead,
  };

  for (const fileName of reqFiles.slice(0, MAX_FILES)) {
    const text = readText(join(repoPath, fileName));
    if (text === null) {
      report.filesNotRead++;
      continue;
    }
    const file = PRINTABLE_FILE.test(fileName) ? fileName : 'a requirements*.txt file';
    // `uv export` notes the ROOT PROJECT by its bare name ("# via myapp"), which reads exactly
    // like another package; in those files the note says nothing this row can use.
    const uvExport = /^#.*\buv export\b/m.test(text.slice(0, 2000));
    const lines = logicalLines(text);
    // One entry per SDK per file: a flood of repeated lines stays one line of output.
    const inThisFile = new Map<string, { entry: PinnedSdk; count: number }>();
    const record = (entry: PinnedSdk): void => {
      const held = inThisFile.get(entry.name);
      if (held) held.count++;
      else inThisFile.set(entry.name, { entry, count: 1 });
    };

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]!;
      if (raw.length > MAX_LINE) {
        report.unreadableLines++;
        continue;
      }
      const line = stripComment(raw);
      if (!line) continue;

      if (line.startsWith('-')) {
        // pip's optparse takes attached values (-rbase.txt) and unambiguous long prefixes.
        if (/^-[rc]/.test(line) || /^--(?:requirem|constr)/.test(line)) report.includes++;
        else if (/^-e/.test(line) || /^--edit/.test(line)) report.editables++;
        else if (!HARMLESS_OPTION.test(line)) report.unreadableLines++;
        continue;
      }
      if (looksLikePathOrUrl(line)) {
        report.unreadableLines++;
        continue;
      }
      const m = REQUIREMENT.exec(line);
      const rest0 = m?.[3]?.trim() ?? '';
      if (!m || !SPEC_START.test(rest0)) {
        report.unreadableLines++;
        continue;
      }
      const name = SDK_BY_NAME.get(pep503(m[1]!));
      if (!name) continue; // a readable requirement for another package: not this row's business

      const refuse = (reason: string): PinnedSdk => ({ name, file, version: null, resolution: null, reason, viaOthersOnly: false });
      let rest = rest0;
      if (rest.startsWith('@')) {
        record(refuse('a URL or VCS requirement, not a registry release — NOT resolved'));
        continue;
      }
      const semi = rest.indexOf(';');
      if (semi >= 0 && rest.slice(semi + 1).trim()) {
        record(refuse('an environment marker makes this pin conditional — NOT resolved'));
        continue;
      }
      if (semi >= 0) rest = rest.slice(0, semi);
      // Per-requirement options (--hash=...) follow the spec; they do not change the version.
      rest = rest.split(/\s--/)[0]!.trim();
      const paren = /^\((.*)\)$/.exec(rest);
      if (paren) rest = paren[1]!.trim();

      // One exact clause: no comma (a second clause), no "===" (arbitrary equality) and no
      // "*" (==1.* is a prefix match, a range by PEP 440).
      const pin = /^==\s*([^\s,=*][^\s,*]*)$/.exec(rest);
      if (!pin) {
        record(refuse('a range or no version, not an exact == pin — NOT resolved'));
        continue;
      }
      const version = pin[1]!;
      const spec = version.length <= 256 ? parseSdkSpec(`pypi:${name}@${version}`) : null;
      if (!spec) {
        record(refuse('an exact == pin in a version form this build does not read — NOT resolved'));
        continue;
      }
      const via = uvExport ? null : viaNote(lines, i);
      const resolution = resolveSdk(releases, spec, now);
      record({
        name,
        file,
        version,
        resolution,
        reason: resolution.reason,
        viaOthersOnly: via !== null && via.length > 0 && !via.some(isDirectInput),
      });
    }

    // The same SDK more than once in one file: pip would refuse or pick one; this row picks neither.
    for (const { entry, count } of inThisFile.values()) {
      report.sdks.push(
        count > 1
          ? { ...entry, version: null, resolution: null, viaOthersOnly: false, reason: `listed ${count} times in ${file} — NOT resolved` }
          : entry,
      );
    }
  }

  report.sdks.sort((a, b) => PYPI_SDKS.indexOf(a.name) - PYPI_SDKS.indexOf(b.name) || a.file.localeCompare(b.file));
  return report;
}
