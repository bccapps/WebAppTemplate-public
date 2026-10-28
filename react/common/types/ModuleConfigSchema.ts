/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Types for module configuration schemas (frontend mirror of backend types)
 */

export type ConfigFieldType = 'string' | 'number' | 'boolean' | 'select' | 'multiselect' | 'json' | 'secret';

export type ConfigFieldOption = {
  value: string;
  label: string;
};

export type ConfigFieldValidation = {
  min?: number;
  max?: number;
  pattern?: string;
  patternMessage?: string;
};

export type ConfigFieldVisibility = {
  /** Key of another field of the same schema whose value drives the visibility. */
  field: string;
  /** The field is only shown when the driver field's value is one of these (compared as strings). */
  in: string[];
};

export type ConfigFieldSchema = {
  key: string;
  label: string;
  description?: string;
  type: ConfigFieldType;
  defaultValue?: any;
  required?: boolean;
  options?: ConfigFieldOption[];
  /**
   * For 'select'/'multiselect' fields: key of a frontend route registry
   * (see RouteRegistry in reactcommon/common) whose entries are merged
   * into `options` at render time. Lets an app's routes populate this
   * field's choices without the shared module knowing them upfront.
   */
  dynamicOptionsKey?: string;
  validation?: ConfigFieldValidation;
  group?: string;
  /** Hide this field from the generic admin config UI (managed by a dedicated UI) */
  hidden?: boolean;
  /**
   * Conditional visibility in the generic admin config UI: the field is only
   * rendered when the driver field's current value matches. Hidden fields keep
   * their stored value — they are just not shown nor editable.
   */
  visibleWhen?: ConfigFieldVisibility;
  /**
   * 'secret' fields only: an admin may read the stored value back (the eye button of `ModuleConfigForm`, the
   * `/secret/:key` route) only when the field opts in with `true`. Absent = write-only: the value can be replaced
   * or cleared but is never sent back, to the admin screen either.
   */
  revealable?: boolean;
};

export type ModuleConfigSchema = {
  moduleId: string;
  moduleName: string;
  description?: string;
  icon?: string;
  fields: ConfigFieldSchema[];
};

export type ModuleConfigWithValues = ModuleConfigSchema & {
  currentValues: Record<string, any>;
  /** For fields of type 'secret': value is always null in currentValues; this map tells if a value is stored. */
  secretsIsSet: Record<string, boolean>;
};
