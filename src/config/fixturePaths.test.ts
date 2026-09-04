import { describe, expect, it } from 'vitest';
import type { LlmRegistry } from '../types.js';
import { autoApplyVerification } from '../usage/llmRegistry.js';
import { isTestFixturePath, scanConfigText } from './scanConfig.js';

const REG: LlmRegistry = [
  { provider: 'openai', kind: 'model_id', deprecated: 'gpt-3.5-turbo', replacement: 'gpt-5.6-terra', status: 'deprecated', shutdownDate: '2026-10-23', verification: autoApplyVerification() },
];

describe('UI metadata keys are never selectors (partner audits, 2026-09-04)', () => {
  it('`default_model_placeholder` in a form schema is catalog data', () => {
    const ms = scanConfigText('litellm/proxy/public_endpoints/provider_create_fields.json', '{"default_model_placeholder": "gpt-3.5-turbo"}\n', REG);
    expect(ms).toHaveLength(1);
    expect(ms[0].position).toBe('config_catalog');
    expect(ms[0].tier).toBe('C');
  });
  it('a plain `model:` key in a deployable config stays a selector candidate', () => {
    const ms = scanConfigText('deploy/app.yaml', 'model: gpt-3.5-turbo\n', REG);
    expect(ms[0].position).toBe('config_selector');
    expect(ms[0].tier).toBe('B');
  });
});

describe('router model_list, mock fixtures and gitignored configs (partner audits, 2026-09-04)', () => {
  it('`model_name` beside `litellm_params` is the alias; the sibling `model:` is the selector', () => {
    const text = 'model_list:\n  - model_name: gpt-3.5-turbo\n    litellm_params:\n      model: gpt-3.5-turbo\n      api_key: os.environ/OPENAI_API_KEY\n';
    const ms = scanConfigText('helm/litellm-helm/values.yaml', text, REG);
    const alias = ms.find((m) => m.key === 'model_name');
    const selector = ms.find((m) => m.key === 'model');
    expect(alias?.position).toBe('config_catalog');
    expect(selector?.position).toBe('config_selector');
    expect(selector?.tier).toBe('B');
  });
  it('an entry with a fake key is a stub; a real entry beside it stays a selector (Helm values shape)', () => {
    const text =
      'model_list:\n  - model_name: gpt-3.5-turbo\n    litellm_params:\n      model: gpt-3.5-turbo\n      api_key: eXaMpLeOnLy\n' +
      '  - model_name: stub\n    litellm_params:\n      model: gpt-3.5-turbo\n      api_key: fake-key\n';
    const ms = scanConfigText('helm/litellm-helm/values.yaml', text, REG);
    const real = ms.find((m) => m.line === 4);
    const stub = ms.find((m) => m.line === 8);
    expect(real?.position).toBe('config_selector');
    expect(stub?.position).toBe('config_catalog');
  });
  it('a file with mock-testing flags is a test fixture, whatever its path', () => {
    const text = 'general_settings:\n  dangerously_allow_mock_testing_request_params: true\nmodel_list:\n  - model_name: my-model\n    litellm_params:\n      model: gpt-3.5-turbo\n';
    const ms = scanConfigText('proxy_server_config.yaml', text, REG);
    expect(ms.every((m) => m.position === 'config_catalog')).toBe(true);
  });
  it('a file the repo gitignores is a local artifact, not deployed configuration', () => {
    const ms = scanConfigText('litellm/proxy/_super_secret_config.yaml', 'model: gpt-3.5-turbo\n', REG, { gitignored: true });
    expect(ms[0].position).toBe('config_catalog');
  });
});

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
  it('treats templates, cookbooks and example configs as informational (partner audits, 2026-09-04)', () => {
    expect(isTestFixturePath('mem0-ts/src/oss/.env.example')).toBe(true);
    expect(isTestFixturePath('.env.sample')).toBe(true);
    expect(isTestFixturePath('config/settings.example.yaml')).toBe(true);
    expect(isTestFixturePath('deploy/values-template.yaml')).toBe(true);
    expect(isTestFixturePath('cookbook/litellm_router/config.yaml')).toBe(true);
    expect(isTestFixturePath('litellm/proxy/example_config_yaml/simple_config.yaml')).toBe(true);
    expect(isTestFixturePath('benchmarks/bench_config.json')).toBe(true);
    expect(isTestFixturePath('litellm/proxy/guardrails/guardrail_hooks/generic_guardrail_api/example_config.yaml')).toBe(true);
    expect(isTestFixturePath('conf/sample-settings.json')).toBe(true);
  });
  it('leaves real configuration alone', () => {
    expect(isTestFixturePath('.env')).toBe(false);
    expect(isTestFixturePath('config/settings.yaml')).toBe(false);
    expect(isTestFixturePath('config/app.yaml')).toBe(false);
    expect(isTestFixturePath('deploy/values.production.yaml')).toBe(false);
    expect(isTestFixturePath('src/settings.json')).toBe(false);
  });
});
