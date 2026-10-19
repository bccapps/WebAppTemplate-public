/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, expect, it } from '@jest/globals';
import { ModuleConfigService, toBooleanString } from './ModuleConfigService';
import { ModuleConfigSchema } from '../types/ModuleConfigSchema';

const SCHEMA: ModuleConfigSchema = {
  moduleId: 'marketIntelligence',
  moduleName: 'Market Intelligence',
  description: '',
  icon: 'insights',
  fields: [
    { key: 'marketIntelligence_ecbEnabled', label: 'ECB', description: '', type: 'boolean', defaultValue: true, group: 'sources' },
    { key: 'marketIntelligence_tradingEconomicsEnabled', label: 'TE', description: '', type: 'boolean', defaultValue: false, group: 'sources' },
    { key: 'marketIntelligence_fredApiKey', label: 'FRED key', description: '', type: 'secret', defaultValue: '', group: 'sources' },
  ],
};

function makeService(configValues: Record<string, unknown>): ModuleConfigService {
  const registry = { getAllSchemas: () => [SCHEMA], getSchema: () => SCHEMA } as never;
  const configService = { get: (key: string) => configValues[key] } as never;
  return new ModuleConfigService(registry, {} as never, configService, {} as never);
}

describe('ModuleConfigService.getResolvedValue', () => {
  it('falls back to the schema default when the key has no row (undefined) — the boot-race case', () => {
    // Reproduces the 2026-09-24 incident: right after a backend restart, ConfigurationService's
    // in-memory cache can be momentarily empty even for a key whose default-seeded DB row already
    // exists — get() returns undefined either way. getResolvedValue must still resolve to `true`
    // here (the schema's declared default), matching what the admin config screen already shows,
    // instead of leaving a data-ingestion prerequisite check thinking it's unsatisfied.
    const service = makeService({});
    expect(service.getResolvedValue('marketIntelligence_ecbEnabled')).toBe(true);
    expect(service.getResolvedValue('marketIntelligence_tradingEconomicsEnabled')).toBe(false);
  });

  it('uses the actual stored value (parsed) once it is present, even when it overrides the default', () => {
    const service = makeService({ marketIntelligence_tradingEconomicsEnabled: 'true' });
    expect(service.getResolvedValue('marketIntelligence_tradingEconomicsEnabled')).toBe(true);
  });

  it('returns a secret raw (ciphertext or undefined), never the empty-string default', () => {
    const unset = makeService({});
    expect(unset.getResolvedValue('marketIntelligence_fredApiKey')).toBeUndefined();

    const set = makeService({ marketIntelligence_fredApiKey: 'enc:abc' });
    expect(set.getResolvedValue('marketIntelligence_fredApiKey')).toBe('enc:abc');
  });

  it('returns the raw value unchanged for a key no schema owns', () => {
    const service = makeService({ someUnrelatedKey: 'raw-value' });
    expect(service.getResolvedValue('someUnrelatedKey')).toBe('raw-value');
  });
});

describe('toBooleanString', () => {
  it('parses string booleans instead of treating every non-empty string as true', () => {
    expect(toBooleanString('false')).toBe('false');
    expect(toBooleanString('FALSE')).toBe('false');
    expect(toBooleanString('0')).toBe('false');
    expect(toBooleanString('')).toBe('false');
    expect(toBooleanString('true')).toBe('true');
    expect(toBooleanString(' True ')).toBe('true');
    expect(toBooleanString('1')).toBe('true');
  });

  it('keeps real booleans and numbers as before', () => {
    expect(toBooleanString(true)).toBe('true');
    expect(toBooleanString(false)).toBe('false');
    expect(toBooleanString(1)).toBe('true');
    expect(toBooleanString(0)).toBe('false');
    expect(toBooleanString(null)).toBe('false');
  });
});
