/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/// <reference types="multer" />

import { Injectable, Logger } from '@nestjs/common';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import * as fs from 'fs/promises';
import * as path from 'path';
import { FunctionalException } from '../exceptions/FunctionalException';
import { ModuleConfigService } from './ModuleConfigService';

export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_CACHE_CONTROL = 'public, max-age=31536000, immutable';

const IMAGE_MIME_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

type StorageProvider = 'local' | 'r2';

/**
 * Generic image storage under a `namespace` (e.g. `cms/covers`,
 * `user-inline`) so unrelated features never collide, with two provider
 * backends selected by `common_storage_provider` (see `storageConfigSchema`,
 * same admin-configurable pattern as `EmailService`'s provider):
 *
 * - `local` (default): the shared volume (`SHARED_DIRECTORY`), so a URL
 *   minted by one instance resolves from any instance sharing that volume —
 *   correct as long as every backend replica sits on the SAME host (a Docker
 *   named volume is host-local, never shared across separate physical
 *   hosts). This is why it deliberately does NOT follow `UserService`'s
 *   avatar convention (`process.cwd()/storage`, instance-local disk): fine
 *   for an avatar the app itself always serves live, wrong for anything
 *   fetched externally over time.
 * - `r2`: a Cloudflare R2 bucket (S3-compatible), served directly from its
 *   own public URL via `publicUrl()` — correct across any number of hosts,
 *   since it isn't host-local storage at all. Switching providers never
 *   touches files already written under the previous one: `read()` stays
 *   local-disk only (legacy images already referenced in frozen HTML keep
 *   resolving via `GET /api/v1/inline-image/:filename`), an R2 object is
 *   never read back through this service.
 */
@Injectable()
export class ImageStorageService {
  private static readonly DEFAULT_DEV_SHARED_DIR = 'tmp/shared';
  private static readonly DEFAULT_PROD_SHARED_DIR = '/app/shared';

  private readonly logger = new Logger(ImageStorageService.name);
  private s3Client: S3Client | null = null;
  private s3ConfigHash = '';

  constructor(private readonly moduleConfigService: ModuleConfigService) {}

  private getConfigValue(key: string): string {
    return String(this.moduleConfigService.getDecryptedValue(key) ?? '');
  }

  /** Currently selected storage provider: `local` (default) or `r2`. */
  getProvider(): StorageProvider {
    return this.getConfigValue('common_storage_provider') === 'r2' ? 'r2' : 'local';
  }

  private buildS3ConfigHash(): string {
    return [
      'common_storage_r2_accountId',
      'common_storage_r2_accessKeyId',
      'common_storage_r2_secretAccessKey',
      'common_storage_r2_bucket',
    ]
      .map((key) => this.getConfigValue(key))
      .join('|');
  }

  /** Lazily built, rebuilt only when the R2 credentials actually change — same caching shape as `EmailService.createTransport()`. */
  private getS3Client(): { client: S3Client; bucket: string } {
    const accountId = this.getConfigValue('common_storage_r2_accountId');
    const accessKeyId = this.getConfigValue('common_storage_r2_accessKeyId');
    const secretAccessKey = this.getConfigValue('common_storage_r2_secretAccessKey');
    const bucket = this.getConfigValue('common_storage_r2_bucket');
    if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
      throw new FunctionalException('IMG', "Stockage R2 sélectionné mais ses identifiants ne sont pas tous renseignés");
    }

    const hash = this.buildS3ConfigHash();
    if (!this.s3Client || hash !== this.s3ConfigHash) {
      this.s3Client = new S3Client({
        region: 'auto',
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        forcePathStyle: true,
        credentials: { accessKeyId, secretAccessKey },
      });
      this.s3ConfigHash = hash;
    }
    return { client: this.s3Client, bucket };
  }

  private resolveSharedDir(): string {
    return process.env.SHARED_DIRECTORY && process.env.SHARED_DIRECTORY.trim().length > 0
      ? process.env.SHARED_DIRECTORY.trim()
      : process.env.NODE_ENV === 'production'
      ? ImageStorageService.DEFAULT_PROD_SHARED_DIR
      : ImageStorageService.DEFAULT_DEV_SHARED_DIR;
  }

  private async ensureDir(namespace: string): Promise<string> {
    const dir = path.resolve(this.resolveSharedDir(), namespace);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  /**
   * Writes an uploaded image under `namespace`, named `${baseName}${extension}`. Returns the
   * stored filename. `cacheControl` defaults to a year-long immutable cache — correct for
   * callers whose filenames are never reused (e.g. `InlineImageController`'s timestamp+random
   * names), but a caller that reuses a deterministic filename across re-uploads (e.g. a CMS
   * cover image keyed by article id) MUST pass a short-lived value instead, or a replaced image
   * stays cached under the old one for a year.
   */
  async write(namespace: string, baseName: string, file: Express.Multer.File, cacheControl: string = DEFAULT_CACHE_CONTROL): Promise<string> {
    if (!file) {
      throw new FunctionalException('IMG', 'Aucun fichier fourni');
    }
    const ext = IMAGE_MIME_EXTENSIONS[file.mimetype];
    if (!ext) {
      throw new FunctionalException('IMG', `Type d'image non supporté: ${file.mimetype}`);
    }
    if (file.size > IMAGE_MAX_BYTES) {
      throw new FunctionalException('IMG', 'Image trop volumineuse (5 Mo maximum)');
    }
    const filename = `${baseName}${ext}`;

    if (this.getProvider() === 'r2') {
      const { client, bucket } = this.getS3Client();
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: `${namespace}/${filename}`,
          Body: file.buffer,
          ContentType: file.mimetype,
          CacheControl: cacheControl,
        }),
      );
      return filename;
    }

    const dir = await this.ensureDir(namespace);
    await fs.writeFile(path.join(dir, filename), file.buffer);
    return filename;
  }

  /**
   * Public URL an R2-stored image is directly reachable at (no backend
   * involved in serving it), or null when the current provider is `local` —
   * the caller then falls back to the existing `GET
   * /api/v1/inline-image/:filename` backend route instead.
   */
  publicUrl(namespace: string, filename: string): string | null {
    if (this.getProvider() !== 'r2') return null;
    const base = this.getConfigValue('common_storage_r2_publicBaseUrl');
    if (!base) {
      this.logger.warn('R2 storage selected but common_storage_r2_publicBaseUrl is not set — image URL cannot be built');
      return null;
    }
    return `${base.replace(/\/+$/, '')}/${namespace}/${encodeURIComponent(filename)}`;
  }

  /**
   * Resolves a previously stored image from LOCAL disk, or null when it does
   * not exist. Never consulted for an R2-stored image — those are served
   * directly from their `publicUrl()`, never through this service.
   */
  async read(namespace: string, filename: string): Promise<{ absolutePath: string; mimeType: string } | null> {
    const dir = await this.ensureDir(namespace);
    const absPath = path.join(dir, path.basename(filename));
    const exists = await fs
      .access(absPath)
      .then(() => true)
      .catch(() => false);
    if (!exists) return null;
    const ext = path.extname(absPath).toLowerCase();
    const mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return { absolutePath: absPath, mimeType };
  }
}
