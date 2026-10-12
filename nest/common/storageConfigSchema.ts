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
 * Where `ImageStorageService` writes uploaded inline images (topic
 * header/footer, communication body — see `InlineImageController`).
 * `local` (default) is the disk-based behaviour every app has today, fine as
 * long as there is exactly one backend host — a Docker named volume is
 * shared between replicas of the SAME host, never across separate physical
 * hosts. `r2` switches new uploads to a Cloudflare R2 bucket, served
 * directly from its own public URL — see `ImageStorageService.publicUrl()`.
 * Switching providers never touches already-uploaded files: anything on
 * local disk keeps being served exactly as before by
 * `GET /api/v1/inline-image/:filename`.
 */
export const storageConfigSchema: ModuleConfigSchema = {
  moduleId: 'common',
  moduleName: 'Common',
  description: 'Inline image storage configuration',
  fields: [
    {
      key: 'common_storage_provider',
      label: 'common.storage.provider',
      description: 'common.storage.provider.description',
      type: 'select',
      defaultValue: 'local',
      group: 'storage',
      options: [
        { value: 'local', label: 'common.storage.provider.local' },
        { value: 'r2', label: 'common.storage.provider.r2' },
      ],
    },
    {
      key: 'common_storage_r2_accountId',
      label: 'common.storage.r2AccountId',
      description: 'common.storage.r2AccountId.description',
      type: 'string',
      defaultValue: '',
      group: 'storage',
      visibleWhen: { field: 'common_storage_provider', in: ['r2'] },
    },
    {
      key: 'common_storage_r2_accessKeyId',
      label: 'common.storage.r2AccessKeyId',
      description: 'common.storage.r2AccessKeyId.description',
      type: 'string',
      defaultValue: '',
      group: 'storage',
      visibleWhen: { field: 'common_storage_provider', in: ['r2'] },
    },
    {
      key: 'common_storage_r2_secretAccessKey',
      label: 'common.storage.r2SecretAccessKey',
      description: 'common.storage.r2SecretAccessKey.description',
      type: 'secret',
      defaultValue: '',
      group: 'storage',
      visibleWhen: { field: 'common_storage_provider', in: ['r2'] },
    },
    {
      key: 'common_storage_r2_bucket',
      label: 'common.storage.r2Bucket',
      description: 'common.storage.r2Bucket.description',
      type: 'string',
      defaultValue: '',
      group: 'storage',
      visibleWhen: { field: 'common_storage_provider', in: ['r2'] },
    },
    {
      // Custom domain (recommended) or the bucket's r2.dev URL — whichever
      // Cloudflare serves the bucket's objects from publicly. Used verbatim
      // as the prefix `publicUrl()` builds returned image URLs from.
      key: 'common_storage_r2_publicBaseUrl',
      label: 'common.storage.r2PublicBaseUrl',
      description: 'common.storage.r2PublicBaseUrl.description',
      type: 'string',
      defaultValue: '',
      group: 'storage',
      visibleWhen: { field: 'common_storage_provider', in: ['r2'] },
    },
  ],
};
