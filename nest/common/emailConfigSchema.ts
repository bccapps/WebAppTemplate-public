/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { ModuleConfigSchema } from './types/ModuleConfigSchema';

export const emailConfigSchema: ModuleConfigSchema = {
  moduleId: 'common',
  moduleName: 'Common',
  description: 'Email sending configuration',
  fields: [
    {
      key: 'common_email_provider',
      label: 'common.email.provider',
      description: 'common.email.provider.description',
      type: 'select',
      defaultValue: 'none',
      group: 'email',
      options: [
        { value: 'none', label: 'common.email.provider.none' },
        { value: 'brevo', label: 'common.email.provider.brevo' },
        { value: 'mailjet', label: 'common.email.provider.mailjet' },
        { value: 'smtp', label: 'common.email.provider.smtp' },
      ],
    },
    {
      key: 'common_email_fromAddress',
      label: 'common.email.fromAddress',
      description: 'common.email.fromAddress.description',
      type: 'string',
      defaultValue: '',
      group: 'email',
      visibleWhen: { field: 'common_email_provider', in: ['brevo', 'mailjet', 'smtp'] },
    },
    {
      key: 'common_email_fromName',
      label: 'common.email.fromName',
      description: 'common.email.fromName.description',
      type: 'string',
      defaultValue: '',
      group: 'email',
      visibleWhen: { field: 'common_email_provider', in: ['brevo', 'mailjet', 'smtp'] },
    },
    {
      key: 'common_email_brevoApiKey',
      label: 'common.email.brevoApiKey',
      description: 'common.email.brevoApiKey.description',
      type: 'secret',
      defaultValue: '',
      group: 'email',
      visibleWhen: { field: 'common_email_provider', in: ['brevo'] },
    },
    {
      key: 'common_email_brevoUser',
      label: 'common.email.brevoUser',
      description: 'common.email.brevoUser.description',
      type: 'string',
      defaultValue: '',
      group: 'email',
      visibleWhen: { field: 'common_email_provider', in: ['brevo'] },
    },
    {
      // Brevo's SMTP relay password and its REST api-key are two distinct
      // credentials: the relay takes an SMTP key, the REST API takes an
      // `xkeysib-…` key sent in the `api-key` header. Statistics and the
      // remaining-credits lookup need the latter, so it gets its own field
      // rather than reusing the relay password and failing with a 401.
      key: 'common_email_brevoRestApiKey',
      label: 'common.email.brevoRestApiKey',
      description: 'common.email.brevoRestApiKey.description',
      type: 'secret',
      defaultValue: '',
      group: 'email',
      visibleWhen: { field: 'common_email_provider', in: ['brevo'] },
    },
    {
      key: 'common_email_mailjetApiKey',
      label: 'common.email.mailjetApiKey',
      description: 'common.email.mailjetApiKey.description',
      type: 'string',
      defaultValue: '',
      group: 'email',
      visibleWhen: { field: 'common_email_provider', in: ['mailjet'] },
    },
    {
      key: 'common_email_mailjetSecretKey',
      label: 'common.email.mailjetSecretKey',
      description: 'common.email.mailjetSecretKey.description',
      type: 'secret',
      defaultValue: '',
      group: 'email',
      visibleWhen: { field: 'common_email_provider', in: ['mailjet'] },
    },
    {
      key: 'common_email_smtpHost',
      label: 'common.email.smtpHost',
      description: 'common.email.smtpHost.description',
      type: 'string',
      defaultValue: '',
      group: 'email',
      visibleWhen: { field: 'common_email_provider', in: ['smtp'] },
    },
    {
      key: 'common_email_smtpPort',
      label: 'common.email.smtpPort',
      description: 'common.email.smtpPort.description',
      type: 'number',
      defaultValue: 465,
      group: 'email',
      visibleWhen: { field: 'common_email_provider', in: ['smtp'] },
      validation: { min: 1, max: 65535 },
    },
    {
      key: 'common_email_smtpSecure',
      label: 'common.email.smtpSecure',
      description: 'common.email.smtpSecure.description',
      type: 'boolean',
      defaultValue: true,
      group: 'email',
      visibleWhen: { field: 'common_email_provider', in: ['smtp'] },
    },
    {
      key: 'common_email_smtpUser',
      label: 'common.email.smtpUser',
      description: 'common.email.smtpUser.description',
      type: 'string',
      defaultValue: '',
      group: 'email',
      visibleWhen: { field: 'common_email_provider', in: ['smtp'] },
    },
    {
      key: 'common_email_smtpPassword',
      label: 'common.email.smtpPassword',
      description: 'common.email.smtpPassword.description',
      type: 'secret',
      defaultValue: '',
      group: 'email',
      visibleWhen: { field: 'common_email_provider', in: ['smtp'] },
    },

    // --- Bulk sending: throttle, budget and provider callbacks ---------------
    {
      // Neither Mailjet nor Brevo publishes a usable SMTP throughput figure, so
      // a mass send is throttled client-side and back-pressure (4xx/421) is
      // treated as the real signal. These two drive the nodemailer pool.
      key: 'common_email_maxConnections',
      label: 'common.email.maxConnections',
      description: 'common.email.maxConnections.description',
      type: 'number',
      defaultValue: 5,
      group: 'email',
      validation: { min: 1, max: 50 },
      visibleWhen: { field: 'common_email_provider', in: ['brevo', 'mailjet', 'smtp'] },
    },
    {
      key: 'common_email_ratePerSecond',
      label: 'common.email.ratePerSecond',
      description: 'common.email.ratePerSecond.description',
      type: 'number',
      defaultValue: 10,
      group: 'email',
      validation: { min: 1, max: 500 },
      visibleWhen: { field: 'common_email_provider', in: ['brevo', 'mailjet', 'smtp'] },
    },
    {
      // Mailjet exposes no credit-balance endpoint at all (checked against
      // /myprofile, /user, /apikey, /apikeytotals and /sender). The only way to
      // show a remaining balance for it is to state the plan allowance here and
      // subtract the month-to-date volume read from /statcounters.
      key: 'common_email_monthlyAllowance',
      label: 'common.email.monthlyAllowance',
      description: 'common.email.monthlyAllowance.description',
      type: 'number',
      defaultValue: 0,
      group: 'email',
      validation: { min: 0 },
      visibleWhen: { field: 'common_email_provider', in: ['brevo', 'mailjet', 'smtp'] },
    },
    {
      key: 'common_email_costPer1000',
      label: 'common.email.costPer1000',
      description: 'common.email.costPer1000.description',
      type: 'number',
      defaultValue: 0,
      group: 'email',
      validation: { min: 0 },
      visibleWhen: { field: 'common_email_provider', in: ['brevo', 'mailjet', 'smtp'] },
    },
    {
      key: 'common_email_currency',
      label: 'common.email.currency',
      description: 'common.email.currency.description',
      type: 'string',
      defaultValue: 'EUR',
      group: 'email',
      visibleWhen: { field: 'common_email_provider', in: ['brevo', 'mailjet', 'smtp'] },
    },
    {
      // Sits in the public webhook path so only the provider, which was handed
      // the full URL at registration time, can post events to us.
      key: 'common_email_webhookSecret',
      label: 'common.email.webhookSecret',
      description: 'common.email.webhookSecret.description',
      type: 'secret',
      defaultValue: '',
      group: 'email',
      visibleWhen: { field: 'common_email_provider', in: ['brevo', 'mailjet'] },
    },
  ],
};
