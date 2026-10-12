/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { ModuleConfigSchema } from './types/ModuleConfigSchema';

/**
 * Site identity and social channels.
 *
 * These live in `common` rather than in a consuming module because anything the
 * backend renders for the outside world needs them: e-mail layouts, permalinks
 * in notifications, invoice headers. Until now the backend had **no** absolute
 * site URL at all (`VITE_APP_URL` exists front-side but is never read), so every
 * generated link had to be relative — which is unusable in an e-mail.
 *
 * Every value is optional on purpose: a consumer renders nothing for an empty
 * key rather than emitting a broken link or an empty icon.
 */
export const brandConfigSchema: ModuleConfigSchema = {
  moduleId: 'common',
  moduleName: 'Common',
  description: 'Site identity and social channels',
  fields: [
    {
      key: 'common_brand_siteUrl',
      label: 'common.brand.siteUrl',
      description: 'common.brand.siteUrl.description',
      type: 'string',
      defaultValue: '',
      group: 'brand',
    },
    {
      key: 'common_brand_apiUrl',
      label: 'common.brand.apiUrl',
      description: 'common.brand.apiUrl.description',
      type: 'string',
      defaultValue: '',
      group: 'brand',
    },
    {
      key: 'common_brand_siteName',
      label: 'common.brand.siteName',
      description: 'common.brand.siteName.description',
      type: 'string',
      defaultValue: '',
      group: 'brand',
    },
    {
      key: 'common_brand_logoUrl',
      label: 'common.brand.logoUrl',
      description: 'common.brand.logoUrl.description',
      type: 'string',
      defaultValue: '',
      group: 'brand',
    },
    {
      key: 'common_brand_headerBannerUrl',
      label: 'common.brand.headerBannerUrl',
      description: 'common.brand.headerBannerUrl.description',
      type: 'string',
      defaultValue: '',
      group: 'brand',
    },
    {
      key: 'common_brand_accentColor',
      label: 'common.brand.accentColor',
      description: 'common.brand.accentColor.description',
      type: 'string',
      defaultValue: '#F4B000',
      group: 'brand',
      validation: {
        pattern: '^#[0-9a-fA-F]{6}$',
        patternMessage: 'common.brand.accentColor.patternMessage',
      },
    },
    {
      key: 'common_brand_legalLine',
      label: 'common.brand.legalLine',
      description: 'common.brand.legalLine.description',
      type: 'string',
      defaultValue: '',
      group: 'brand',
    },
    {
      key: 'common_brand_postalAddress',
      label: 'common.brand.postalAddress',
      description: 'common.brand.postalAddress.description',
      type: 'string',
      defaultValue: '',
      group: 'brand',
    },
    {
      key: 'common_social_x',
      label: 'common.social.x',
      description: 'common.social.urlHint',
      type: 'string',
      defaultValue: '',
      group: 'social',
    },
    {
      key: 'common_social_youtube',
      label: 'common.social.youtube',
      description: 'common.social.urlHint',
      type: 'string',
      defaultValue: '',
      group: 'social',
    },
    {
      key: 'common_social_linkedin',
      label: 'common.social.linkedin',
      description: 'common.social.urlHint',
      type: 'string',
      defaultValue: '',
      group: 'social',
    },
    {
      key: 'common_social_instagram',
      label: 'common.social.instagram',
      description: 'common.social.urlHint',
      type: 'string',
      defaultValue: '',
      group: 'social',
    },
    {
      key: 'common_social_telegram',
      label: 'common.social.telegram',
      description: 'common.social.urlHint',
      type: 'string',
      defaultValue: '',
      group: 'social',
    },
    {
      key: 'common_social_discord',
      label: 'common.social.discord',
      description: 'common.social.urlHint',
      type: 'string',
      defaultValue: '',
      group: 'social',
    },
  ],
};
