/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable } from '@nestjs/common';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import * as fs from 'fs/promises';
import * as path from 'path';
import { FunctionalException } from '../exceptions/FunctionalException';
import { ModuleConfigService } from './ModuleConfigService';
import { appDataSubdir } from '../utils/appDataDir';

type PrivateStorageProvider = 'local' | 'r2';

/**
 * Object storage for files that must NEVER be publicly reachable (invoice PDFs, private
 * logos, exports): bytes in, bytes out, no public URL — unlike `ImageStorageService`, whose
 * R2 bucket is public by design. Callers hand over a relative `key` (`invoices/SHOP-2026-0001.pdf`)
 * and keep it; they never build paths.
 *
 * Provider selected by `common_private_storage_provider` (see `storageConfigSchema`):
 * - `local` (default): `<APP_DATA_DIR>/private/<key>` when `APP_DATA_DIR` is set, else
 *   `<cwd>/storage/<key>` — the layout apps already had, so existing files stay valid. Deliberately
 *   NOT `SHARED_DIRECTORY`, which a self-hosted front may serve publicly.
 * - `r2`: a PRIVATE Cloudflare R2 bucket (no custom domain, no r2.dev). Account and credentials
 *   fall back to the public-storage ones (`common_storage_r2_*`) when left empty.
 */
@Injectable()
export class PrivateStorageService {
  private s3Client: S3Client | null = null;
  private s3ConfigHash = '';

  constructor(private readonly moduleConfigService: ModuleConfigService) {}

  private getConfigValue(key: string): string {
    return String(this.moduleConfigService.getDecryptedValue(key) ?? '');
  }

  /** A private-storage value, or the matching public-storage one when it is left empty. */
  private getWithFallback(privateKey: string, publicKey: string): string {
    return this.getConfigValue(privateKey) || this.getConfigValue(publicKey);
  }

  getProvider(): PrivateStorageProvider {
    return this.getConfigValue('common_private_storage_provider') === 'r2' ? 'r2' : 'local';
  }

  private getS3Client(): { client: S3Client; bucket: string } {
    const accountId = this.getWithFallback('common_private_storage_r2_accountId', 'common_storage_r2_accountId');
    const accessKeyId = this.getWithFallback('common_private_storage_r2_accessKeyId', 'common_storage_r2_accessKeyId');
    const secretAccessKey = this.getWithFallback(
      'common_private_storage_r2_secretAccessKey',
      'common_storage_r2_secretAccessKey',
    );
    const bucket = this.getConfigValue('common_private_storage_r2_bucket');
    if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
      throw new FunctionalException('STO', "Stockage privé R2 sélectionné mais ses identifiants ne sont pas tous renseignés");
    }

    const hash = [accountId, accessKeyId, secretAccessKey, bucket].join('|');
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

  /** Rejects anything but a plain relative key, so a key can never escape the storage root. */
  private assertKey(key: string): void {
    const segments = key.split('/');
    if (!key || key.startsWith('/') || key.includes('\\') || segments.some((s) => !s || s === '.' || s === '..')) {
      throw new FunctionalException('STO', `Clé de stockage invalide: ${key}`);
    }
  }

  private localPath(key: string): string {
    const root = appDataSubdir('private') ?? path.resolve(process.cwd(), 'storage');
    return path.join(root, key);
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    this.assertKey(key);
    if (this.getProvider() === 'r2') {
      const { client, bucket } = this.getS3Client();
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
      return;
    }
    const absPath = this.localPath(key);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, body);
  }

  /** The stored bytes, or `null` when nothing exists under `key`. */
  async get(key: string): Promise<Buffer | null> {
    this.assertKey(key);
    if (this.getProvider() === 'r2') {
      const { client, bucket } = this.getS3Client();
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return res.Body ? Buffer.from(await res.Body.transformToByteArray()) : null;
      } catch (err) {
        if ((err as { name?: string }).name === 'NoSuchKey') return null;
        throw err;
      }
    }
    return fs.readFile(this.localPath(key)).catch(() => null);
  }

  /** Removes `key`; absent keys are not an error. */
  async remove(key: string): Promise<void> {
    this.assertKey(key);
    if (this.getProvider() === 'r2') {
      const { client, bucket } = this.getS3Client();
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      return;
    }
    await fs.unlink(this.localPath(key)).catch(() => undefined);
  }
}
