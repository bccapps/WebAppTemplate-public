/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { Help } from '../help/helpText';

export type ParamValue = string | number | boolean;

/** Current values of a form, by field key. A missing key means "default". */
export type ParamValues = Record<string, ParamValue | undefined>;

/**
 * Generic description of one setting. The form is generated from a list of these (`ParamsSchema`), for instance
 * parsed from a server answer: nothing here is specific to an application.
 *
 * Texts are given as an i18n key (`labelId`) or as an already-translated string (`label`); the key wins.
 */
interface ParamFieldBase {
  /** Unique key; it is the key of the value in `ParamValues`. */
  key: string;
  labelId?: string;
  label?: string;
  /** Contextual help, shown through an `InfoTip` next to the label. */
  help?: Help;
  /** Shown only after the user expands the "Advanced" section. */
  advanced?: boolean;
  /** Visible only while another field has the given value (e.g. a reference file is attached). */
  showWhen?: { key: string; equals: ParamValue };
}

export interface NumberParamField extends ParamFieldBase {
  /** `int` rounds the value. */
  type: 'int' | 'float';
  default: number;
  min?: number;
  max?: number;
  /** Default 1 for `int`, 0.1 for `float`. Also sets the displayed decimals. */
  step?: number;
}

export interface BoolParamField extends ParamFieldBase {
  type: 'bool';
  default?: boolean;
}

export interface SelectOption {
  value: string | number;
  labelId?: string;
  label?: string;
}

export interface SelectParamField extends ParamFieldBase {
  type: 'select';
  options: SelectOption[];
  default: string | number;
}

export interface TextParamField extends ParamFieldBase {
  type: 'text';
  default?: string;
  placeholder?: string;
}

export type ParamField = NumberParamField | BoolParamField | SelectParamField | TextParamField;

/** A settings schema: the ordered list of fields. */
export type ParamsSchema = readonly ParamField[];
