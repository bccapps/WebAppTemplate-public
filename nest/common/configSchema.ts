/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { ModuleConfigSchema } from './types/ModuleConfigSchema';

export const commonConfigSchema: ModuleConfigSchema = {
  moduleId: 'common',
  moduleName: 'Common',
  description: 'Core application configuration',
  fields: [
    {
      key: 'useLandingPage',
      label: 'common.useLandingPage',
      description: 'common.useLandingPage.description',
      type: 'boolean',
      defaultValue: false,
      group: 'general',
    },
    {
      key: 'localesLanguages',
      label: 'common.localesLanguages',
      description: 'common.localesLanguages.description',
      type: 'string',
      defaultValue: 'fr,en',
      group: 'general',
    },
    {
      key: 'localesCategories',
      label: 'common.localesCategories',
      description: 'common.localesCategories.description',
      type: 'string',
      defaultValue: 'common,custom',
      group: 'general',
    },
    {
      key: 'localesLocation',
      label: 'common.localesLocation',
      description: 'common.localesLocation.description',
      type: 'select',
      defaultValue: 'remote',
      group: 'general',
      options: [
        { value: 'local', label: 'common.localesLocation.local' },
        { value: 'remote', label: 'common.localesLocation.remote' },
      ],
    },
    {
      key: 'localeDefault',
      label: 'common.localeDefault',
      description: 'common.localeDefault.description',
      type: 'string',
      defaultValue: 'en',
      group: 'general',
    },
    {
      key: 'serversideUsers',
      label: 'common.serversideUsers',
      description: 'common.serversideUsers.description',
      type: 'boolean',
      defaultValue: true,
      group: 'general',
    },
    {
      key: 'common_bugReport_recipientEmail',
      label: 'common.bugReport_recipientEmail',
      description: 'common.bugReport_recipientEmail.description',
      type: 'string',
      defaultValue: '',
      group: 'general',
    },
    {
      key: 'features',
      label: 'common.features',
      description: 'common.features.description',
      type: 'json',
      defaultValue: '{}',
      group: 'general',
    },
    {
      key: 'common_gzip_threshold',
      label: 'common.gzip_threshold',
      description: 'common.gzip_threshold.description',
      type: 'number',
      defaultValue: 1024,
      group: 'performance',
    },
    {
      key: 'common_transport_deflate_threshold',
      label: 'common.transport_deflate_threshold',
      description: 'common.transport_deflate_threshold.description',
      type: 'number',
      defaultValue: 1024,
      group: 'performance',
    },
    {
      key: 'common_diskAlert_enabled',
      label: 'common.diskAlert_enabled',
      description: 'common.diskAlert_enabled.description',
      type: 'boolean',
      defaultValue: false,
      group: 'monitoring',
    },
    {
      // App-wide default rate limit (ThrottlerModule, keyed by authenticated
      // user when a valid token is present, IP otherwise — see AppModule).
      // Generous on purpose: this is the safety net for every route, not the
      // targeted /indicatorvalues limit (blockchainIndicator_throttleLimit).
      key: 'common_throttleDefaultLimit',
      label: 'common.throttleDefaultLimit',
      description: 'common.throttleDefaultLimit.description',
      type: 'number',
      defaultValue: 300,
      group: 'performance',
      validation: { min: 1 },
    },
    {
      key: 'common_throttleDefaultTtlMs',
      label: 'common.throttleDefaultTtlMs',
      description: 'common.throttleDefaultTtlMs.description',
      type: 'number',
      defaultValue: 60000,
      group: 'performance',
      validation: { min: 1000 },
    },
    {
      // Hard cap of the live transport sessions (POST /api/v1/crypt/session is anonymous): past it the oldest are
      // evicted (CryptSessionService, in memory or in Redis). Read on every handshake.
      key: 'common_cryptSessionMaxLive',
      label: 'common.cryptSessionMaxLive',
      description: 'common.cryptSessionMaxLive.description',
      type: 'number',
      defaultValue: 50000,
      group: 'performance',
      validation: { min: 100, max: 10000000 },
    },
    {
      // Cache-Control on GET /api/v1/configurations — only reachable because that
      // route is exempted from transport encryption (@NoTransportCrypt, decision C,
      // PERFORMANCE_PLAN.md §2.0): an encrypted response is a unique ciphertext per
      // request, so Cache-Control on one caches nothing. See §2.1.
      key: 'common_cacheControl_configurations_maxAge',
      label: 'common.cacheControl_configurations_maxAge',
      description: 'common.cacheControl_configurations_maxAge.description',
      type: 'number',
      defaultValue: 60,
      group: 'performance',
      validation: { min: 0 },
    },
    {
      key: 'common_cacheControl_configurations_staleWhileRevalidate',
      label: 'common.cacheControl_configurations_staleWhileRevalidate',
      description: 'common.cacheControl_configurations_staleWhileRevalidate.description',
      type: 'number',
      defaultValue: 600,
      group: 'performance',
      validation: { min: 0 },
    },
    {
      // Cache-Control on GET /api/v1/locales[/:category] — same exemption as above.
      key: 'common_cacheControl_locales_maxAge',
      label: 'common.cacheControl_locales_maxAge',
      description: 'common.cacheControl_locales_maxAge.description',
      type: 'number',
      defaultValue: 300,
      group: 'performance',
      validation: { min: 0 },
    },
    {
      key: 'common_cacheControl_locales_staleWhileRevalidate',
      label: 'common.cacheControl_locales_staleWhileRevalidate',
      description: 'common.cacheControl_locales_staleWhileRevalidate.description',
      type: 'number',
      defaultValue: 86400,
      group: 'performance',
      validation: { min: 0 },
    },
  ],
};
