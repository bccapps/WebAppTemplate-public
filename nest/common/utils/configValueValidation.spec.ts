/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { describe, expect, it } from '@jest/globals';
import { ConfigFieldSchema } from '../types/ModuleConfigSchema';
import { CONFIG_VALUE_MAX_LENGTH, validateConfigFieldValue, validatePlainConfigValue } from './configValueValidation';

const field = (overrides: Partial<ConfigFieldSchema>): ConfigFieldSchema =>
  ({ key: 'demo_field', label: 'l', type: 'string', ...overrides }) as ConfigFieldSchema;

const code = (f: ConfigFieldSchema, value: unknown): string | null => validateConfigFieldValue(f, value)?.code ?? null;

describe('validateConfigFieldValue', () => {
  it('accepts a blank value for every type (how screens clear a field)', () => {
    for (const type of ['string', 'number', 'boolean', 'select', 'multiselect', 'json'] as const) {
      for (const blank of [null, undefined, '', '  ']) expect(code(field({ type, options: [{ value: 'a', label: 'a' }] }), blank)).toBeNull();
    }
  });

  it('number: numeric strings and numbers pass, junk and booleans are refused, min/max enforced', () => {
    const f = field({ type: 'number', validation: { min: 1, max: 10 } });
    expect(code(f, 5)).toBeNull();
    expect(code(f, '5')).toBeNull();
    expect(code(f, 'abc')).toBe('CFG_INVALID_NUMBER');
    expect(code(f, 'Infinity')).toBe('CFG_INVALID_NUMBER');
    expect(code(f, true)).toBe('CFG_INVALID_NUMBER');
    expect(code(f, 0)).toBe('CFG_OUT_OF_RANGE');
    expect(code(f, '11')).toBe('CFG_OUT_OF_RANGE');
  });

  it('boolean: accepts the forms the stored/parsed values use, refuses the rest', () => {
    const f = field({ type: 'boolean' });
    for (const ok of [true, false, 'true', 'false', '1', '0', 1, 0, 'TRUE']) expect(code(f, ok)).toBeNull();
    expect(code(f, 'yes')).toBe('CFG_INVALID_BOOLEAN');
    expect(code(f, 2)).toBe('CFG_INVALID_BOOLEAN');
  });

  it('select: the value must be one of the options, unless the options are dynamic or absent', () => {
    const options = [{ value: 'local', label: 'L' }, { value: 'remote', label: 'R' }];
    expect(code(field({ type: 'select', options }), 'remote')).toBeNull();
    expect(code(field({ type: 'select', options }), 'other')).toBe('CFG_INVALID_OPTION');
    expect(code(field({ type: 'select', options }), { a: 1 })).toBe('CFG_INVALID_FORMAT');
    expect(code(field({ type: 'select', options, dynamicOptionsKey: 'routes' }), '/anything')).toBeNull();
    expect(code(field({ type: 'select' }), 'free')).toBeNull();
  });

  it('multiselect: array, JSON array string and CSV are checked item by item', () => {
    const f = field({ type: 'multiselect', options: [{ value: 'a', label: 'a' }, { value: 'b', label: 'b' }] });
    expect(code(f, ['a', 'b'])).toBeNull();
    expect(code(f, '["a"]')).toBeNull();
    expect(code(f, 'a, b')).toBeNull();
    expect(code(f, ['a', 'z'])).toBe('CFG_INVALID_OPTION');
    expect(code(f, '["z"]')).toBe('CFG_INVALID_OPTION');
    expect(code(f, { a: 1 })).toBe('CFG_INVALID_FORMAT');
    expect(code(f, [{ a: 1 }])).toBe('CFG_INVALID_FORMAT');
  });

  it('json: strings must parse, structured values pass', () => {
    const f = field({ type: 'json' });
    expect(code(f, '{"a":1}')).toBeNull();
    expect(code(f, { a: 1 })).toBeNull();
    expect(code(f, [1, 2])).toBeNull();
    expect(code(f, '{not json')).toBe('CFG_INVALID_JSON');
  });

  it('string: primitives only, optional pattern, size cap; a broken schema pattern never locks the field', () => {
    expect(code(field({}), 'hello')).toBeNull();
    expect(code(field({}), { a: 1 })).toBe('CFG_INVALID_FORMAT');
    const colour = field({ validation: { pattern: '^#[0-9a-f]{6}$', patternMessage: 'hex colour' } });
    expect(code(colour, '#aabbcc')).toBeNull();
    expect(validateConfigFieldValue(colour, 'red')).toEqual({ code: 'CFG_INVALID_FORMAT', reason: 'hex colour' });
    expect(code(field({ validation: { pattern: '([' } }), 'x')).toBeNull();
    expect(code(field({}), 'x'.repeat(CONFIG_VALUE_MAX_LENGTH + 1))).toBe('CFG_VALUE_TOO_LONG');
  });

  it('secret: text only, size capped, error reasons never echo the value', () => {
    const f = field({ type: 'secret' });
    expect(code(f, 'sk_live_123')).toBeNull();
    expect(code(f, { a: 1 })).toBe('CFG_INVALID_FORMAT');
    const issue = validateConfigFieldValue(field({ type: 'number' }), 'sk_live_super_secret');
    expect(JSON.stringify(issue)).not.toContain('sk_live_super_secret');
  });
});

describe('validatePlainConfigValue', () => {
  it('accepts text, numbers and blanks; refuses objects and oversized values', () => {
    expect(validatePlainConfigValue('x')).toBeNull();
    expect(validatePlainConfigValue(3)).toBeNull();
    expect(validatePlainConfigValue(null)).toBeNull();
    expect(validatePlainConfigValue({ a: 1 })?.code).toBe('CFG_INVALID_FORMAT');
    expect(validatePlainConfigValue('x'.repeat(CONFIG_VALUE_MAX_LENGTH + 1))?.code).toBe('CFG_VALUE_TOO_LONG');
  });
});
