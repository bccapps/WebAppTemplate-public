/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Write rules of `PUT /api/v1/configurations` (ConfigurationService.updateFromAdmin) and
 * `PUT /api/v1/admin/module-configs/:moduleId` (ModuleConfigService.updateModuleConfig), then a replay of the
 * payload shapes the admin screens and internal callers really send (AdminPage, AdminModules, AdminFeatures,
 * ModuleConfigForm, AdminAuth, AdminUsertradingplatform, AdminLlmChat, AdminDonations, TradeKong calibration...).
 */
import { describe, expect, it, jest } from '@jest/globals';
import { FunctionalException } from '../exceptions/FunctionalException';
import { ModuleConfigSchema } from '../types/ModuleConfigSchema';
import { buildConfigStack } from '../testing/ConfigAdminWrites.testkit';

jest.mock('src/config/defaultConfig', () => ({
  defaultConfigEntries: [{ name: 'localeDefault', value: 'fr', description: 'Fallback language' }],
}));

const SCHEMA: ModuleConfigSchema = {
  moduleId: 'demo',
  moduleName: 'Demo',
  fields: [
    { key: 'demo_count', label: 'Count', type: 'number', defaultValue: 5, validation: { min: 1, max: 10 } },
    { key: 'demo_on', label: 'On', type: 'boolean', defaultValue: false },
    { key: 'demo_mode', label: 'Mode', type: 'select', defaultValue: 'a', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
    { key: 'demo_tags', label: 'Tags', type: 'multiselect', defaultValue: [], options: [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }] },
    { key: 'demo_json', label: 'Json', type: 'json', defaultValue: '{}' },
    { key: 'demo_name', label: 'Name', type: 'string', defaultValue: '' },
    { key: 'demo_secret', label: 'Secret', type: 'secret', defaultValue: '' },
    { key: 'features', label: 'Features', type: 'json', defaultValue: '{}', description: 'features desc' },
  ],
};

const STORED = [
  { name: 'demo_count', value: '5', description: '' },
  { name: 'demo_on', value: 'false', description: '' },
  { name: 'demo_mode', value: 'a', description: '' },
  { name: 'demo_secret', value: 'enc:old-secret', description: '' },
  { name: 'features', value: '{}', description: 'features desc' },
  { name: 'localeDefault', value: 'fr', description: 'Fallback language' },
  { name: 'app_title', value: 'My app', description: 'Title' },
  { name: 'api_url_demo', value: '/api/v1', description: 'Demo API' },
];

const refusal = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(FunctionalException);
    return (error as FunctionalException).code;
  }
  throw new Error('expected a FunctionalException');
};

describe('PUT /configurations (ConfigurationService.updateFromAdmin)', () => {
  it('refuses an unknown key and writes nothing, even for the valid entries of the same payload', async () => {
    const { config, valueOf } = buildConfigStack([SCHEMA], STORED);
    const code = await refusal(config.updateFromAdmin([
      { name: 'app_title', value: 'Changed', description: 'Title' },
      { name: 'brand_new_key', value: 'x', description: '' },
    ]));
    expect(code).toBe('CFG_UNKNOWN_KEY');
    expect(valueOf('app_title')).toBe('My app');
    expect(valueOf('brand_new_key')).toBeUndefined();
  });

  it('accepts a key that is in defaultConfigEntries or owned by a module schema even if its row is missing', async () => {
    const { config, valueOf } = buildConfigStack([SCHEMA], []);
    await config.updateFromAdmin([
      { name: 'localeDefault', value: 'en', description: 'Fallback language' },
      { name: 'demo_count', value: '7', description: '' },
    ]);
    expect(valueOf('localeDefault')).toBe('en');
    expect(valueOf('demo_count')).toBe('7');
  });

  it('updates a plain key and its description exactly as before and returns the refreshed list', async () => {
    const { config, valueOf } = buildConfigStack([SCHEMA], STORED);
    const result = await config.updateFromAdmin([{ name: 'app_title', value: 'New', description: 'New title' }]);
    expect(valueOf('app_title')).toBe('New');
    expect(result.find((dto) => dto.name === 'app_title')).toEqual({ name: 'app_title', value: 'New', description: 'New title' });
  });

  it('accepts an unchanged value without validating it (legacy stored values that do not conform)', async () => {
    const legacy = [
      ...STORED.filter((row) => row.name !== 'demo_count' && row.name !== 'demo_mode' && row.name !== 'features'),
      { name: 'demo_count', value: 'not-a-number', description: '' },
      { name: 'demo_mode', value: 'retired-option', description: '' },
      { name: 'features', value: '{broken', description: '' },
    ];
    const { config, valueOf } = buildConfigStack([SCHEMA], legacy);
    await config.updateFromAdmin([
      { name: 'demo_count', value: 'not-a-number', description: '' },
      { name: 'demo_mode', value: 'retired-option', description: '' },
      { name: 'features', value: '{broken', description: '' },
    ]);
    expect(valueOf('demo_count')).toBe('not-a-number');
    expect(valueOf('features')).toBe('{broken');
  });

  it('validates a CHANGED module-owned value against its field (number, range, select, json, boolean)', async () => {
    const { config, valueOf } = buildConfigStack([SCHEMA], STORED);
    expect(await refusal(config.updateFromAdmin([{ name: 'demo_count', value: 'abc', description: '' }]))).toBe('CFG_INVALID_NUMBER');
    expect(await refusal(config.updateFromAdmin([{ name: 'demo_count', value: '99', description: '' }]))).toBe('CFG_OUT_OF_RANGE');
    expect(await refusal(config.updateFromAdmin([{ name: 'demo_mode', value: 'zzz', description: '' }]))).toBe('CFG_INVALID_OPTION');
    expect(await refusal(config.updateFromAdmin([{ name: 'features', value: '{oops', description: '' }]))).toBe('CFG_INVALID_JSON');
    expect(await refusal(config.updateFromAdmin([{ name: 'demo_on', value: 'maybe', description: '' }]))).toBe('CFG_INVALID_BOOLEAN');
    expect(valueOf('demo_count')).toBe('5');
    await config.updateFromAdmin([{ name: 'demo_count', value: '8', description: '' }, { name: 'demo_on', value: 'true', description: '' }]);
    expect(valueOf('demo_count')).toBe('8');
    expect(valueOf('demo_on')).toBe('true');
  });

  it('secret: empty value leaves the stored secret untouched, unchanged ciphertext passes, a new value is refused', async () => {
    const { config, valueOf } = buildConfigStack([SCHEMA], STORED);
    await config.updateFromAdmin([{ name: 'demo_secret', value: '', description: '' }]);
    expect(valueOf('demo_secret')).toBe('enc:old-secret');
    await config.updateFromAdmin([{ name: 'demo_secret', value: 'enc:old-secret', description: '' }]);
    expect(valueOf('demo_secret')).toBe('enc:old-secret');
    const code = await refusal(config.updateFromAdmin([{ name: 'demo_secret', value: 'sk_live_plaintext', description: '' }]));
    expect(code).toBe('CFG_SECRET_READONLY');
    expect(valueOf('demo_secret')).toBe('enc:old-secret');
  });

  it('never puts a submitted value in the error message', async () => {
    const { config } = buildConfigStack([SCHEMA], STORED);
    for (const dto of [
      { name: 'demo_secret', value: 'sk_live_plaintext', description: '' },
      { name: 'demo_count', value: 'sk_live_plaintext', description: '' },
    ]) {
      await config.updateFromAdmin([dto]).catch((error: Error) => expect(error.message).not.toContain('sk_live_plaintext'));
    }
  });

  it('ignores entries without a name and a non-array payload, as before; refuses object values', async () => {
    const { config } = buildConfigStack([SCHEMA], STORED);
    await expect(config.updateFromAdmin([{ name: '', value: 'x', description: '' }, null as never])).resolves.toBeDefined();
    await expect(config.updateFromAdmin(undefined as never)).resolves.toBeDefined();
    expect(await refusal(config.updateFromAdmin([{ name: 'app_title', value: { a: 1 } as never, description: '' }]))).toBe('CFG_INVALID_FORMAT');
  });

  it('keeps updateAll (internal callers) permissive: it still creates unknown keys', async () => {
    const { config, valueOf } = buildConfigStack([SCHEMA], STORED);
    await config.updateAll([{ name: 'bitcoinlab_enabledTimeframes', value: 'h1,d1', description: 'internal' }]);
    expect(valueOf('bitcoinlab_enabledTimeframes')).toBe('h1,d1');
  });
});

describe('PUT /admin/module-configs/:moduleId (ModuleConfigService.updateModuleConfig)', () => {
  it('refuses invalid CHANGED values per type and writes nothing', async () => {
    const { moduleConfig, valueOf } = buildConfigStack([SCHEMA], STORED);
    expect(await refusal(moduleConfig.updateModuleConfig('demo', { demo_count: 'abc' }))).toBe('CFG_INVALID_NUMBER');
    expect(await refusal(moduleConfig.updateModuleConfig('demo', { demo_count: 0 }))).toBe('CFG_OUT_OF_RANGE');
    expect(await refusal(moduleConfig.updateModuleConfig('demo', { demo_on: 'maybe' }))).toBe('CFG_INVALID_BOOLEAN');
    expect(await refusal(moduleConfig.updateModuleConfig('demo', { demo_mode: 'zzz' }))).toBe('CFG_INVALID_OPTION');
    expect(await refusal(moduleConfig.updateModuleConfig('demo', { demo_tags: ['x', 'nope'] }))).toBe('CFG_INVALID_OPTION');
    expect(await refusal(moduleConfig.updateModuleConfig('demo', { demo_json: '{oops' }))).toBe('CFG_INVALID_JSON');
    expect(await refusal(moduleConfig.updateModuleConfig('demo', { demo_name: 'x'.repeat(1_000_001) }))).toBe('CFG_VALUE_TOO_LONG');
    // atomic: a valid field next to an invalid one is not written either
    expect(await refusal(moduleConfig.updateModuleConfig('demo', { demo_count: 9, demo_mode: 'zzz' }))).toBe('CFG_INVALID_OPTION');
    expect(valueOf('demo_count')).toBe('5');
  });

  it('accepts valid values, serialized exactly as before', async () => {
    const { moduleConfig, valueOf } = buildConfigStack([SCHEMA], STORED);
    const result = await moduleConfig.updateModuleConfig('demo', {
      demo_count: 7, demo_on: true, demo_mode: 'b', demo_tags: ['x', 'y'], demo_json: { a: 1 }, demo_name: 'hello',
    });
    expect(valueOf('demo_count')).toBe('7');
    expect(valueOf('demo_on')).toBe('true');
    expect(valueOf('demo_tags')).toBe('["x","y"]');
    expect(valueOf('demo_json')).toBe('{"a":1}');
    expect(result?.currentValues.demo_count).toBe(7);
  });

  it('leaves unchanged legacy values alone and still ignores unknown keys', async () => {
    const legacy = STORED.map((row) => (row.name === 'demo_count' ? { ...row, value: '500' } : row)); // above max 10
    const { moduleConfig, valueOf } = buildConfigStack([SCHEMA], legacy);
    await moduleConfig.updateModuleConfig('demo', { demo_count: 500, not_in_schema: 'whatever', uid: 12 });
    expect(valueOf('demo_count')).toBe('500');
    expect(valueOf('not_in_schema')).toBeUndefined();
  });

  it('secret: empty/null keeps the stored one, a new value is encrypted, a bad type is refused', async () => {
    const { moduleConfig, valueOf } = buildConfigStack([SCHEMA], STORED);
    await moduleConfig.updateModuleConfig('demo', { demo_secret: null });
    await moduleConfig.updateModuleConfig('demo', { demo_secret: '' });
    expect(valueOf('demo_secret')).toBe('enc:old-secret');
    await moduleConfig.updateModuleConfig('demo', { demo_secret: 'new-secret' });
    expect(valueOf('demo_secret')).toBe('enc:new-secret');
    expect(await refusal(moduleConfig.updateModuleConfig('demo', { demo_secret: { a: 1 } }))).toBe('CFG_INVALID_FORMAT');
  });

  it('returns null for an unknown module, as before', async () => {
    const { moduleConfig } = buildConfigStack([SCHEMA], STORED);
    await expect(moduleConfig.updateModuleConfig('nope', {})).resolves.toBeNull();
  });
});

describe('replay of real payload shapes', () => {
  it('AdminPage global save: the whole GET /admin/configurations list is sent back, edited or not', async () => {
    const { config, valueOf } = buildConfigStack([SCHEMA], STORED);
    const global = STORED.filter((row) => !['demo_', 'features', 'api_url_'].some((prefix) => row.name.startsWith(prefix)));
    const payload = global.map(({ name, value, description }) => ({ name, value: name === 'app_title' ? 'Edited' : value, description }));
    await expect(config.updateFromAdmin(payload)).resolves.toBeDefined();
    expect(valueOf('app_title')).toBe('Edited');
    expect(valueOf('localeDefault')).toBe('fr');
  });

  it('AdminModules: single api_url_* entry carrying its description', async () => {
    const { config, valueOf } = buildConfigStack([SCHEMA], STORED);
    await config.updateFromAdmin([{ name: 'api_url_demo', value: 'https://demo.example.com/api/v1', description: 'Demo API' }]);
    expect(valueOf('api_url_demo')).toBe('https://demo.example.com/api/v1');
  });

  it('AdminFeatures: `features` JSON string, also when the row did not exist yet (module-owned key)', async () => {
    const { config, valueOf } = buildConfigStack([SCHEMA], STORED.filter((row) => row.name !== 'features'));
    const value = JSON.stringify({ chat: { enabled: true, props: ['a'] } });
    await config.updateFromAdmin([{ name: 'features', value, description: 'features desc' }]);
    expect(valueOf('features')).toBe(value);
  });

  it('ModuleConfigForm: every field resent with current values (secret = null, numbers as numbers)', async () => {
    const { moduleConfig } = buildConfigStack([SCHEMA], STORED);
    await expect(moduleConfig.updateModuleConfig('demo', {
      demo_count: 5, demo_on: false, demo_mode: 'a', demo_tags: [], demo_json: '{}', demo_name: '', demo_secret: null, features: {},
    })).resolves.toBeDefined();
    // a cleared number input sends ''
    await expect(moduleConfig.updateModuleConfig('demo', { demo_count: '' })).resolves.toBeDefined();
  });

  it('AdminUsertradingplatform-style: every value sent as a string', async () => {
    const { moduleConfig, valueOf } = buildConfigStack([SCHEMA], STORED);
    await moduleConfig.updateModuleConfig('demo', { demo_count: '6', demo_name: 'abc', demo_mode: 'b' });
    expect(valueOf('demo_count')).toBe('6');
  });

  it('AdminLlmChat-style: null for a cleared text field and a number', async () => {
    const { moduleConfig } = buildConfigStack([SCHEMA], STORED);
    await expect(moduleConfig.updateModuleConfig('demo', { demo_name: null, demo_count: 10 })).resolves.toBeDefined();
  });

  it('internal caller (TradeKong slippage calibration): a pre-stringified JSON object for a json field', async () => {
    const { moduleConfig } = buildConfigStack([SCHEMA], STORED);
    await expect(moduleConfig.updateModuleConfig('demo', { demo_json: JSON.stringify({ 'BTC/USDT': { baseBps: 1.2 } }) })).resolves.toBeDefined();
  });

  it('internal caller (data-ingestion switches): a single boolean', async () => {
    const { moduleConfig, valueOf } = buildConfigStack([SCHEMA], STORED);
    await moduleConfig.updateModuleConfig('demo', { demo_on: true });
    expect(valueOf('demo_on')).toBe('true');
  });
});
