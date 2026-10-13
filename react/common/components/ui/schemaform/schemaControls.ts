/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { Help, Translate } from '../help/helpText';
import { resolveText } from '../help/helpText';
import type { ParamField, ParamsSchema, ParamValue, ParamValues, SelectOption } from './schemaTypes';

interface ControlBase {
  key: string;
  label: string;
  help?: Help;
  advanced: boolean;
}

/** What the UI renders for one field, with the current value and everything needed to draw it. */
export type ControlModel = ControlBase &
  (
    | { kind: 'slider'; value: number; min: number; max: number; step: number; decimals: number; integer: boolean }
    | { kind: 'number'; value: number; min?: number; max?: number; step: number; decimals: number; integer: boolean }
    | { kind: 'switch'; value: boolean }
    | { kind: 'select'; value: string | number; options: { value: string | number; label: string }[] }
    | { kind: 'text'; value: string; placeholder?: string }
  );

/** Number of decimals implied by a step (0.25 gives 2, 1 gives 0). */
export function decimalsOf(step: number): number {
  const text = String(step);
  if (text.includes('e-')) return Number(text.split('e-')[1]);
  return (text.split('.')[1] ?? '').length;
}

function numberStep(field: ParamField): number {
  if (field.type === 'int') return field.step ?? 1;
  if (field.type === 'float') return field.step ?? 0.1;
  return 1;
}

/** Default value of a field. */
export function fieldDefault(field: ParamField): ParamValue {
  if (field.type === 'bool') return field.default ?? false;
  if (field.type === 'text') return field.default ?? '';
  return field.default;
}

/** Values of every field set to its default. */
export function defaultValues(schema: ParamsSchema): Record<string, ParamValue> {
  return Object.fromEntries(schema.map((field) => [field.key, fieldDefault(field)]));
}

/**
 * Normalizes a raw input into a valid value for the field: numbers are parsed, clamped to `min`/`max`, rounded
 * (`int`) or limited to the step's decimals; a value that cannot be used (NaN, unknown option) gives the default.
 */
export function coerceValue(field: ParamField, raw: unknown): ParamValue {
  if (field.type === 'bool') return typeof raw === 'boolean' ? raw : fieldDefault(field);
  if (field.type === 'text') return typeof raw === 'string' ? raw : fieldDefault(field);
  if (field.type === 'select') return field.options.some((o) => o.value === raw) ? (raw as string | number) : field.default;
  const parsed = typeof raw === 'string' && raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(parsed)) return field.default;
  const clamped = Math.min(field.max ?? Infinity, Math.max(field.min ?? -Infinity, parsed));
  if (field.type === 'int') return Math.round(clamped);
  return Number(clamped.toFixed(decimalsOf(numberStep(field))));
}

function effectiveValue(field: ParamField, values: ParamValues): ParamValue {
  const raw = values[field.key];
  return raw === undefined ? fieldDefault(field) : coerceValue(field, raw);
}

/** Whether the field is visible given the other values (`showWhen`). */
export function isFieldVisible(field: ParamField, schema: ParamsSchema, values: ParamValues): boolean {
  if (!field.showWhen) return true;
  const { key, equals } = field.showWhen;
  const target = schema.find((f) => f.key === key);
  const current = target ? effectiveValue(target, values) : values[key];
  return current === equals;
}

/** True when at least one value differs from its default (drives a "modified" dot on a trigger button). */
export function isModified(schema: ParamsSchema, values: ParamValues): boolean {
  return schema.some((field) => values[field.key] !== undefined && values[field.key] !== fieldDefault(field));
}

function optionModel(option: SelectOption, translate: Translate) {
  return { value: option.value, label: resolveText(option.labelId, option.label, translate) ?? String(option.value) };
}

/** Builds the control of one field with its current value. */
export function buildControl(field: ParamField, values: ParamValues, translate: Translate): ControlModel {
  const base = {
    key: field.key,
    label: resolveText(field.labelId, field.label, translate) ?? field.key,
    help: field.help,
    advanced: field.advanced === true,
  };
  const value = effectiveValue(field, values);
  if (field.type === 'bool') return { ...base, kind: 'switch', value: value as boolean };
  if (field.type === 'text') return { ...base, kind: 'text', value: value as string, placeholder: field.placeholder };
  if (field.type === 'select') {
    return { ...base, kind: 'select', value: value as string | number, options: field.options.map((o) => optionModel(o, translate)) };
  }
  const step = numberStep(field);
  const numeric = { value: value as number, step, decimals: decimalsOf(step), integer: field.type === 'int' };
  if (field.min !== undefined && field.max !== undefined) return { ...base, kind: 'slider', min: field.min, max: field.max, ...numeric };
  return { ...base, kind: 'number', min: field.min, max: field.max, ...numeric };
}

/** Visible controls split into basic and advanced, in schema order. */
export function buildControls(
  schema: ParamsSchema,
  values: ParamValues,
  translate: Translate,
): { basic: ControlModel[]; advanced: ControlModel[] } {
  const controls = schema.filter((field) => isFieldVisible(field, schema, values)).map((field) => buildControl(field, values, translate));
  return { basic: controls.filter((c) => !c.advanced), advanced: controls.filter((c) => c.advanced) };
}
