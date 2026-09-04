import { describe, expect, it } from 'vitest';
import { isTestFixturePath } from './scanConfig.js';

// M5 (external validation, continue): `extensions/cli/test-fixtures/model-switch-test-config.yaml`
// produced three REVIEW REQUIRED selectors, and a JSON-Schema `default` example
// was reported as live config.
describe('config fixture paths', () => {
  it('recognizes test-fixtures/ directories and *-test-config files', () => {
    expect(isTestFixturePath('extensions/cli/test-fixtures/model-switch-test-config.yaml')).toBe(true);
    expect(isTestFixturePath('cli/model-switch-test-config.yaml')).toBe(true);
    expect(isTestFixturePath('app/foo-test-settings.json')).toBe(true);
    expect(isTestFixturePath('src/__snapshots__/config.json')).toBe(true);
  });
  it('treats JSON Schema files as documentation, not config', () => {
    expect(isTestFixturePath('extensions/vscode/config_schema.json')).toBe(true);
    expect(isTestFixturePath('schemas/app.schema.json')).toBe(true);
  });
  it('leaves real configuration alone', () => {
    expect(isTestFixturePath('config/app.yaml')).toBe(false);
    expect(isTestFixturePath('deploy/values.production.yaml')).toBe(false);
    expect(isTestFixturePath('src/settings.json')).toBe(false);
  });
});
