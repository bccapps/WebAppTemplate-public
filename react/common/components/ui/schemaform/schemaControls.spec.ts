/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, it, expect } from 'vitest';
import {
  buildControl,
  buildControls,
  coerceValue,
  decimalsOf,
  defaultValues,
  fieldDefault,
  isFieldVisible,
  isModified,
} from './schemaControls';
import type { ParamsSchema } from './schemaTypes';

const translate = (key: string) => `[${key}]`;

const schema: ParamsSchema = [
  { key: 'steps', type: 'int', labelId: 'p.steps', default: 20, min: 1, max: 50 },
  { key: 'cfg', type: 'float', label: 'Guidance', default: 4.5, min: 0, max: 20, step: 0.25 },
  { key: 'tiled', type: 'bool', label: 'Tiled', advanced: true },
  { key: 'sampler', type: 'select', label: 'Sampler', default: 'a', options: [{ value: 'a', label: 'A' }, { value: 'b', labelId: 'p.b' }] },
  { key: 'strength', type: 'float', label: 'Strength', default: 0.5, min: 0, max: 1, showWhen: { key: 'tiled', equals: true } },
  { key: 'prompt', type: 'text', label: 'Prompt', placeholder: 'ph' },
  { key: 'count', type: 'int', label: 'Count', default: 1 },
];

const field = (key: string) => schema.find((f) => f.key === key)!;

describe('decimalsOf', () => {
  it('counts the decimals of a step', () => {
    expect(decimalsOf(1)).toBe(0);
    expect(decimalsOf(0.1)).toBe(1);
    expect(decimalsOf(0.25)).toBe(2);
    expect(decimalsOf(1e-7)).toBe(7);
  });
});

describe('defaults', () => {
  it('uses the declared default, false for bool and empty for text', () => {
    expect(fieldDefault(field('steps'))).toBe(20);
    expect(fieldDefault(field('tiled'))).toBe(false);
    expect(fieldDefault(field('prompt'))).toBe('');
    expect(defaultValues(schema)).toMatchObject({ steps: 20, cfg: 4.5, sampler: 'a', tiled: false });
  });
});

describe('coerceValue', () => {
  it('clamps and rounds integers', () => {
    expect(coerceValue(field('steps'), 99)).toBe(50);
    expect(coerceValue(field('steps'), '7.6')).toBe(8);
  });
  it('limits floats to the step decimals', () => {
    expect(coerceValue(field('cfg'), 3.14159)).toBe(3.14);
  });
  it('falls back to the default for NaN, blank and unknown options', () => {
    expect(coerceValue(field('steps'), 'abc')).toBe(20);
    expect(coerceValue(field('steps'), '  ')).toBe(20);
    expect(coerceValue(field('sampler'), 'zzz')).toBe('a');
    expect(coerceValue(field('sampler'), 'b')).toBe('b');
  });
  it('keeps booleans and texts, else the default', () => {
    expect(coerceValue(field('tiled'), true)).toBe(true);
    expect(coerceValue(field('tiled'), 'yes')).toBe(false);
    expect(coerceValue(field('prompt'), 'hi')).toBe('hi');
  });
});

describe('isFieldVisible', () => {
  it('hides a field until its condition is met, using defaults for unset values', () => {
    expect(isFieldVisible(field('strength'), schema, {})).toBe(false);
    expect(isFieldVisible(field('strength'), schema, { tiled: true })).toBe(true);
    expect(isFieldVisible(field('steps'), schema, {})).toBe(true);
  });
});

describe('isModified', () => {
  it('is false for no values or default values, true for a changed one', () => {
    expect(isModified(schema, {})).toBe(false);
    expect(isModified(schema, { steps: 20 })).toBe(false);
    expect(isModified(schema, { steps: 21 })).toBe(true);
  });
});

describe('buildControl', () => {
  it('makes a slider when min and max are known, with the current value', () => {
    expect(buildControl(field('cfg'), { cfg: 7 }, translate)).toMatchObject({
      kind: 'slider', label: 'Guidance', value: 7, min: 0, max: 20, step: 0.25, decimals: 2, integer: false,
    });
  });
  it('makes a number input when a bound is missing', () => {
    expect(buildControl(field('count'), {}, translate)).toMatchObject({ kind: 'number', value: 1, step: 1, integer: true });
  });
  it('resolves labels through the translator and keeps literal ones', () => {
    expect(buildControl(field('steps'), {}, translate).label).toBe('[p.steps]');
    const select = buildControl(field('sampler'), {}, translate);
    expect(select).toMatchObject({ kind: 'select', options: [{ value: 'a', label: 'A' }, { value: 'b', label: '[p.b]' }] });
  });
  it('maps bool and text fields', () => {
    expect(buildControl(field('tiled'), { tiled: true }, translate)).toMatchObject({ kind: 'switch', value: true, advanced: true });
    expect(buildControl(field('prompt'), {}, translate)).toMatchObject({ kind: 'text', value: '', placeholder: 'ph' });
  });
});

describe('buildControls', () => {
  it('splits basic and advanced and drops hidden fields', () => {
    const hidden = buildControls(schema, {}, translate);
    expect(hidden.basic.map((c) => c.key)).toEqual(['steps', 'cfg', 'sampler', 'prompt', 'count']);
    expect(hidden.advanced.map((c) => c.key)).toEqual(['tiled']);
    expect(buildControls(schema, { tiled: true }, translate).basic.map((c) => c.key)).toContain('strength');
  });
});
