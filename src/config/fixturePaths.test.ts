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
  // REVERSED 2026-09-29, deliberately. This asserted that a global mock-testing switch makes every
  // model entry in the file a fixture. That inferred too much: the switch is global in EFFECT — it
  // lets any request be answered with a mock — but it is not evidence that any particular route is
  // fake, and a proxy can permit mock testing while routing production traffic. Demoting every
  // selector on that basis is a false clean waiting to happen.
  //
  // The switch is now recorded as the `global_mock_testing_enabled` RISK SIGNAL and changes no
  // verdict. Entries are judged one at a time, on their own markers.
  it('a global mock-testing switch is recorded as a risk signal, and demotes nothing by itself', () => {
    const text = 'general_settings:\n  dangerously_allow_mock_testing_request_params: true\nmodel_list:\n  - model_name: my-model\n    litellm_params:\n      model: gpt-3.5-turbo\n';
    const ms = scanConfigText('proxy_server_config.yaml', text, REG);
    const sel = ms.find((m) => m.key === 'model');
    // The route is still a route: nothing about it was faked.
    expect(sel?.position).toBe('config_selector');
    // And the switch is visible to a reviewer on that very occurrence.
    expect(sel?.signals).toContain('global_mock_testing_enabled');
  });
  it('the switch is recognised ONLY under root general_settings', () => {
    // Narrowed from a set that also accepted litellm_settings, router_settings and the bare root.
    // That breadth was guesswork; general_settings is where LiteLLM defines it.
    const body = 'model_list:\n  - model_name: m\n    litellm_params:\n      model: gpt-3.5-turbo\n';
    const under = (parent: string) =>
      scanConfigText('c.yaml', `${parent}:\n  dangerously_allow_mock_testing_request_params: true\n${body}`, REG)
        .find((m) => m.key === 'model')?.signals ?? [];
    expect(under('general_settings')).toContain('global_mock_testing_enabled');
    expect(under('litellm_settings')).not.toContain('global_mock_testing_enabled');
    expect(under('router_settings')).not.toContain('global_mock_testing_enabled');
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
