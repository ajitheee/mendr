import { readFile } from 'node:fs/promises';

/**
 * Minimal shape of an OpenAPI 3 spec that the detector needs. We only care
 * about `components.schemas` for Phase 1; everything else is ignored.
 */
export interface OpenApiSpec {
  components?: {
    schemas?: Record<string, any>;
  };
}

/**
 * Load an OpenAPI spec from a local file path (or, in future, a URL).
 *
 * Phase 1 only supports local file paths: read + JSON.parse.
 *
 * TODO(future): also fetch a Stripe spec directly from the `stripe/openapi`
 * GitHub repo by git ref (e.g. resolve a tag/sha to the raw spec3.json URL and
 * fetch it) when `pathOrUrl` looks like a URL or `owner/repo@ref` reference.
 */
export async function loadSpec(pathOrUrl: string): Promise<OpenApiSpec> {
  const raw = await readFile(pathOrUrl, 'utf8');
  return JSON.parse(raw) as OpenApiSpec;
}
