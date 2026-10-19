/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { ConfigFieldSchema } from '../types/ModuleConfigSchema';

/** Hard cap on the size of one stored config value (characters of its string form). */
export const CONFIG_VALUE_MAX_LENGTH = 1_000_000;

export type ConfigValueIssueCode =
  | 'CFG_INVALID_FORMAT'
  | 'CFG_INVALID_NUMBER'
  | 'CFG_OUT_OF_RANGE'
  | 'CFG_INVALID_BOOLEAN'
  | 'CFG_INVALID_OPTION'
  | 'CFG_INVALID_JSON'
  | 'CFG_VALUE_TOO_LONG';

export type ConfigValueIssue = {
  code: ConfigValueIssueCode;
  /** Short English reason; never contains the submitted value (it may be a secret). */
  reason: string;
};

const BOOLEAN_STRINGS = new Set(['true', 'false', '1', '0']);

const isPrimitive = (value: unknown): value is string | number | boolean =>
  ['string', 'number', 'boolean'].includes(typeof value);

const isBlank = (value: unknown): boolean =>
  value === null || value === undefined || (typeof value === 'string' && value.trim() === '');

function stringLength(value: unknown): number {
  if (typeof value === 'string') return value.length;
  try {
    return (JSON.stringify(value) ?? '').length;
  } catch {
    return Infinity;
  }
}

function checkNumber(field: ConfigFieldSchema, value: unknown): ConfigValueIssue | null {
  const num = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(num)) return { code: 'CFG_INVALID_NUMBER', reason: 'expected a finite number' };
  const { min, max } = field.validation ?? {};
  if ((min !== undefined && num < min) || (max !== undefined && num > max)) {
    return { code: 'CFG_OUT_OF_RANGE', reason: `expected a number between ${min ?? '-∞'} and ${max ?? '+∞'}` };
  }
  return null;
}

function checkBoolean(value: unknown): ConfigValueIssue | null {
  if (typeof value === 'boolean') return null;
  if (value === 1 || value === 0) return null;
  if (typeof value === 'string' && BOOLEAN_STRINGS.has(value.trim().toLowerCase())) return null;
  return { code: 'CFG_INVALID_BOOLEAN', reason: 'expected true or false' };
}

/** Options are only enforced when the schema lists them statically (dynamic ones are known to the frontend only). */
function allowedOptions(field: ConfigFieldSchema): Set<string> | null {
  if (field.dynamicOptionsKey || !field.options?.length) return null;
  return new Set(field.options.map((option) => option.value));
}

function checkSelect(field: ConfigFieldSchema, value: unknown): ConfigValueIssue | null {
  if (!isPrimitive(value)) return { code: 'CFG_INVALID_FORMAT', reason: 'expected a single option' };
  const allowed = allowedOptions(field);
  if (allowed && !allowed.has(String(value))) {
    return { code: 'CFG_INVALID_OPTION', reason: `expected one of: ${[...allowed].join(', ')}` };
  }
  return null;
}

/** Same three forms `ModuleConfigService.parseValue` accepts for a multiselect: array, JSON array string, CSV. */
function toList(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [value];
  } catch {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
}

function checkMultiselect(field: ConfigFieldSchema, value: unknown): ConfigValueIssue | null {
  const list = toList(value);
  if (!list || !list.every(isPrimitive)) {
    return { code: 'CFG_INVALID_FORMAT', reason: 'expected a list of options' };
  }
  const allowed = allowedOptions(field);
  const unknown = allowed ? list.find((item) => !allowed.has(String(item))) : undefined;
  return unknown === undefined
    ? null
    : { code: 'CFG_INVALID_OPTION', reason: `expected options among: ${[...allowed!].join(', ')}` };
}

function checkJson(value: unknown): ConfigValueIssue | null {
  if (typeof value !== 'string') return null; // already structured data: always serializable
  try {
    JSON.parse(value);
    return null;
  } catch {
    return { code: 'CFG_INVALID_JSON', reason: 'expected valid JSON' };
  }
}

function checkText(field: ConfigFieldSchema, value: unknown): ConfigValueIssue | null {
  if (!isPrimitive(value)) return { code: 'CFG_INVALID_FORMAT', reason: 'expected a text value' };
  const pattern = field.type === 'string' ? field.validation?.pattern : undefined;
  if (!pattern) return null;
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    return null; // a broken pattern in a schema must not lock the field
  }
  return regex.test(String(value))
    ? null
    : { code: 'CFG_INVALID_FORMAT', reason: field.validation?.patternMessage ?? 'does not match the expected format' };
}

/**
 * Validates a value about to be stored for a module-schema field. A blank value (`null`, `undefined`, `''`) is
 * accepted whatever the type: it is how the admin screens clear a field. Callers only invoke this for values that
 * CHANGE, so legacy stored values that do not conform to the schema stay untouched until someone edits them.
 * Returns the first problem found, or `null` when the value is acceptable.
 */
export function validateConfigFieldValue(field: ConfigFieldSchema, value: unknown): ConfigValueIssue | null {
  if (isBlank(value)) return null;
  if (stringLength(value) > CONFIG_VALUE_MAX_LENGTH) {
    return { code: 'CFG_VALUE_TOO_LONG', reason: `value exceeds ${CONFIG_VALUE_MAX_LENGTH} characters` };
  }
  switch (field.type) {
    case 'number': return checkNumber(field, value);
    case 'boolean': return checkBoolean(value);
    case 'select': return checkSelect(field, value);
    case 'multiselect': return checkMultiselect(field, value);
    case 'json': return checkJson(value);
    default: return checkText(field, value);
  }
}

/** Size check for a value of a key that no module schema owns (plain string expected). */
export function validatePlainConfigValue(value: unknown): ConfigValueIssue | null {
  if (isBlank(value)) return null;
  if (!isPrimitive(value)) return { code: 'CFG_INVALID_FORMAT', reason: 'expected a text value' };
  return String(value).length > CONFIG_VALUE_MAX_LENGTH
    ? { code: 'CFG_VALUE_TOO_LONG', reason: `value exceeds ${CONFIG_VALUE_MAX_LENGTH} characters` }
    : null;
}
