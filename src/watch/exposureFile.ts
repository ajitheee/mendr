import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ExposedModel } from './exposure.js';

// The committed side of the Standing Watch: `.mendr/exposure.json`.
//
// A small, human-readable, diff-friendly record of what deprecated model ids
// the repo touches. It exists for ambient reassurance (a reviewer can see the
// exposure without running anything) and as a stable anchor the issue/badge
// derive from. It stores ONLY durable facts — ids, dates, replacements, source
// urls, occurrence locations — and deliberately NOT the countdown or a
// generated-at timestamp, so re-running the watch on an unchanged repo produces
// a byte-identical file and no commit. The CI workflow never writes it; a
// developer writes it locally with `mendr watch` and commits it if they want it
// tracked.

/** The version tag stored in the file, bumped only on a breaking shape change. */
export const EXPOSURE_SCHEMA = 'mendr-exposure/v2';

/** Repo-relative directory and file the watch record lives in. */
export const EXPOSURE_DIR = '.mendr';
export const EXPOSURE_FILE = 'exposure.json';
export const EXPOSURE_RELATIVE_PATH = `${EXPOSURE_DIR}/${EXPOSURE_FILE}`;

/**
 * The on-disk shape: schema tag + the registry version the exposure was
 * computed against + the exposed-model list. It carries provenance (which
 * registry produced this) but NO per-scan volatility — no timestamp, no scanned
 * commit, no countdown — so re-running on unchanged code against the same
 * registry yields byte-identical output. The scanned commit lives only in the
 * CI `--json` output (see cli.ts), where a per-commit value is not committed and
 * so cannot churn the tracked file.
 */
export interface ExposureFile {
  schema: string;
  /** Identifier of the registry these facts were computed against (a content hash). */
  registryVersion: string;
  models: ExposedModel[];
}

/**
 * Serialize the exposed-model list to the exact bytes written to disk: 2-space
 * indented JSON with a trailing newline. Pure and deterministic — the same
 * models + registry version always produce the same string, which is what keeps
 * the committed file free of no-op churn.
 */
export function serializeExposure(
  models: readonly ExposedModel[],
  registryVersion: string,
): string {
  const file: ExposureFile = { schema: EXPOSURE_SCHEMA, registryVersion, models: [...models] };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** Absolute path of the exposure file under `repoPath`. */
export function exposureFilePath(repoPath: string): string {
  return join(repoPath, EXPOSURE_DIR, EXPOSURE_FILE);
}

/** The outcome of a write: whether the bytes actually changed on disk. */
export interface ExposureWriteResult {
  /** Absolute path written (or that would have been written). */
  path: string;
  /** True when the file was created or its content differed and was rewritten. */
  changed: boolean;
}

/**
 * Write `.mendr/exposure.json` under `repoPath`, but ONLY when its content would
 * differ from what is already there — an unchanged repo leaves the file (and the
 * git status) untouched. Creates the `.mendr/` directory on first write.
 */
export function writeExposureFile(
  repoPath: string,
  models: readonly ExposedModel[],
  registryVersion: string,
): ExposureWriteResult {
  const path = exposureFilePath(repoPath);
  const next = serializeExposure(models, registryVersion);
  if (existsSync(path)) {
    try {
      if (readFileSync(path, 'utf8') === next) return { path, changed: false };
    } catch {
      // Unreadable existing file: fall through and overwrite it.
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next);
  return { path, changed: true };
}

/** Read a previously written exposure file, or undefined when absent/malformed. */
export function readExposureFile(repoPath: string): ExposureFile | undefined {
  const path = exposureFilePath(repoPath);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      Array.isArray((parsed as ExposureFile).models)
    ) {
      return parsed as ExposureFile;
    }
  } catch {
    // Malformed file: treat as absent rather than crash the watch.
  }
  return undefined;
}
