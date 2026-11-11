/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { ConfigFieldSchema, ModuleConfigSchema } from '../common/types/ModuleConfigSchema';

// Configuration of the module (04 §13, keys renamed `interaction_*` since the module is separate, 04 §20). Read at
// every use: no restart needed. Labels are translation keys of `locales/interaction.<lang>.json`.

type Field = Omit<ConfigFieldSchema, 'label' | 'description'>;

const FIELDS: Field[] = [
  {
    key: 'interaction_enabledKinds',
    type: 'multiselect',
    defaultValue: ['browser', 'telegram'],
    group: 'general',
    options: [
      { value: 'browser', label: 'interaction_kind_browser' },
      { value: 'telegram', label: 'interaction_kind_telegram' },
      { value: 'email', label: 'interaction_kind_email' },
      { value: 'webhook', label: 'interaction_kind_webhook' },
    ],
  },
  {
    key: 'interaction_inappDisplayDefault',
    type: 'select',
    defaultValue: 'toast',
    group: 'general',
    options: [
      { value: 'toast', label: 'interaction_display_toast' },
      { value: 'browser', label: 'interaction_display_browser' },
    ],
  },
  { key: 'interaction_defaultTimezone', type: 'string', defaultValue: 'Europe/Paris', group: 'general' },
  { key: 'interaction_maxPerUserHour', type: 'number', defaultValue: 60, group: 'reliability', validation: { min: 0, max: 100000 } },
  { key: 'interaction_askMaxPerUserHour', type: 'number', defaultValue: 30, group: 'reliability', validation: { min: 0, max: 100000 } },
  { key: 'interaction_maxExternalPerHour', type: 'number', defaultValue: 0, group: 'reliability', validation: { min: 0, max: 10000000 } },
  { key: 'interaction_providerTimeoutMs', type: 'number', defaultValue: 10000, group: 'performance', validation: { min: 1000, max: 60000 } },
  { key: 'interaction_askDefaultTtlSeconds', type: 'number', defaultValue: 300, group: 'general', validation: { min: 30, max: 604800 } },
  { key: 'interaction_askMaxTtlSeconds', type: 'number', defaultValue: 86400, group: 'general', validation: { min: 60, max: 604800 } },
  { key: 'interaction_expirySweepMs', type: 'number', defaultValue: 30000, group: 'polling', validation: { min: 5000, max: 600000 } },
  { key: 'interaction_emailCodesPerUserHour', type: 'number', defaultValue: 5, group: 'reliability', validation: { min: 0, max: 10000 } },
  { key: 'interaction_emailCodesPerIpHour', type: 'number', defaultValue: 10, group: 'reliability', validation: { min: 0, max: 10000 } },
  { key: 'interaction_emailCodesPerAddressDay', type: 'number', defaultValue: 3, group: 'reliability', validation: { min: 0, max: 10000 } },
  { key: 'interaction_emailCodesGlobalHour', type: 'number', defaultValue: 60, group: 'reliability', validation: { min: 0, max: 1000000 } },
  { key: 'interaction_testsPerUserHour', type: 'number', defaultValue: 20, group: 'reliability', validation: { min: 0, max: 10000 } },
  { key: 'interaction_testsPerIpHour', type: 'number', defaultValue: 40, group: 'reliability', validation: { min: 0, max: 10000 } },
  { key: 'interaction_testsGlobalHour', type: 'number', defaultValue: 300, group: 'reliability', validation: { min: 0, max: 1000000 } },
  { key: 'interaction_linkCodesPerUserHour', type: 'number', defaultValue: 10, group: 'reliability', validation: { min: 0, max: 10000 } },
  {
    key: 'interaction_telegramMode',
    type: 'select',
    defaultValue: 'own',
    group: 'general',
    options: [
      { value: 'off', label: 'interaction_telegramMode_off' },
      { value: 'own', label: 'interaction_telegramMode_own' },
      { value: 'operator', label: 'interaction_telegramMode_operator' },
      { value: 'both', label: 'interaction_telegramMode_both' },
    ],
  },
  // Write-only: never sent back, the admin screen only says whether it is set.
  { key: 'interaction_telegramOperatorBotToken', type: 'secret', group: 'general', visibleWhen: { field: 'interaction_telegramMode', in: ['operator', 'both'] } },
  {
    key: 'interaction_telegramInbound',
    type: 'select',
    defaultValue: 'poll',
    group: 'polling',
    options: [
      { value: 'poll', label: 'interaction_telegramInbound_poll' },
      { value: 'webhook', label: 'interaction_telegramInbound_webhook' },
    ],
  },
  { key: 'interaction_telegramMaxUserBots', type: 'number', defaultValue: 50, group: 'performance', validation: { min: 0, max: 1000 } },
  { key: 'interaction_telegramStartRepliesPerHour', type: 'number', defaultValue: 20, group: 'reliability', validation: { min: 0, max: 1000 } },
  { key: 'interaction_linkCodeTtlMinutes', type: 'number', defaultValue: 10, group: 'general', validation: { min: 1, max: 60 } },
  { key: 'interaction_emailCodeTtlHours', type: 'number', defaultValue: 24, group: 'general', validation: { min: 1, max: 72 } },
  // Generated on first use (`ConfigVapidKeySource`); the private half is write-only.
  { key: 'interaction_vapidPublicKey', type: 'string', group: 'general', hidden: true },
  { key: 'interaction_vapidPrivateKey', type: 'secret', group: 'general', hidden: true },
  { key: 'interaction_vapidSubject', type: 'string', defaultValue: '', group: 'general' },
  { key: 'interaction_deliveryRetentionDays', type: 'number', defaultValue: 30, group: 'reliability', validation: { min: 1, max: 3650 } },
  { key: 'interaction_noticeRetentionDays', type: 'number', defaultValue: 30, group: 'reliability', validation: { min: 1, max: 3650 } },
  { key: 'interaction_ticketRetentionDays', type: 'number', defaultValue: 90, group: 'reliability', validation: { min: 1, max: 3650 } },
];

export const INTERACTION_MODULE_ID = 'interaction';

export const interactionConfigSchema: ModuleConfigSchema = {
  moduleId: INTERACTION_MODULE_ID,
  moduleName: 'interaction_moduleName',
  description: 'interaction_moduleDescription',
  icon: 'notifications',
  fields: FIELDS.map((field) => ({ ...field, label: field.key, description: `${field.key}_description` })),
};

/** Default value of a key (the schema's), for the typed reader. */
export function interactionDefault(key: string): unknown {
  return FIELDS.find((field) => field.key === key)?.defaultValue;
}
