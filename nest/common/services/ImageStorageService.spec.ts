/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

jest.mock('@aws-sdk/client-s3', () => {
  const send = jest.fn();
  return {
    send,
    S3Client: jest.fn().mockImplementation((config: unknown) => ({ send, config })),
    PutObjectCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
  };
});

const { S3Client, PutObjectCommand } = jest.requireMock('@aws-sdk/client-s3') as {
  S3Client: jest.Mock;
  PutObjectCommand: jest.Mock;
};

import { ImageStorageService } from './ImageStorageService';

const buildFile = (overrides: Partial<Express.Multer.File> = {}): Express.Multer.File =>
  ({
    fieldname: 'file',
    originalname: 'photo.png',
    mimetype: 'image/png',
    size: 100,
    buffer: Buffer.from('fake-image-bytes'),
    ...overrides,
  }) as Express.Multer.File;

const buildService = (values: Record<string, string>): ImageStorageService => {
  const moduleConfigService = { getDecryptedValue: jest.fn((key: string) => values[key] ?? '') };
  return new ImageStorageService(moduleConfigService as never);
};

describe('ImageStorageService', () => {
  const tmpDir = path.join(os.tmpdir(), `image-storage-service-spec-${Date.now()}`);

  beforeEach(() => {
    process.env.SHARED_DIRECTORY = tmpDir;
    jest.clearAllMocks();
  });

  afterAll(async () => {
    delete process.env.SHARED_DIRECTORY;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('local provider (default)', () => {
    it('writes the file to disk under the namespace and returns its filename', async () => {
      const service = buildService({});
      const filename = await service.write('user-inline', 'abc-123', buildFile());

      expect(filename).toBe('abc-123.png');
      const written = await fs.readFile(path.join(tmpDir, 'user-inline', filename));
      expect(written.toString()).toBe('fake-image-bytes');
      expect(S3Client).not.toHaveBeenCalled();
    });

    it('publicUrl returns null — the caller falls back to the backend-hosted URL', () => {
      const service = buildService({});
      expect(service.publicUrl('user-inline', 'abc-123.png')).toBeNull();
    });

    it('read() resolves a file written to disk', async () => {
      const service = buildService({});
      const filename = await service.write('user-inline', 'def-456', buildFile({ mimetype: 'image/webp' }));

      const result = await service.read('user-inline', filename);

      expect(result?.mimeType).toBe('image/webp');
    });
  });

  describe('r2 provider', () => {
    const r2Values: Record<string, string> = {
      common_storage_provider: 'r2',
      common_storage_r2_accountId: 'acc123',
      common_storage_r2_accessKeyId: 'key123',
      common_storage_r2_secretAccessKey: 'secret123',
      common_storage_r2_bucket: 'my-bucket',
      common_storage_r2_publicBaseUrl: 'https://images.example.com/',
    };

    it('uploads via PutObjectCommand instead of writing to disk', async () => {
      const service = buildService(r2Values);

      const filename = await service.write('user-inline', 'ghi-789', buildFile());

      expect(filename).toBe('ghi-789.png');
      expect(PutObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          Bucket: 'my-bucket',
          Key: 'user-inline/ghi-789.png',
          ContentType: 'image/png',
          CacheControl: 'public, max-age=31536000, immutable',
        }),
      );
      await expect(fs.access(path.join(tmpDir, 'user-inline', filename))).rejects.toThrow();
    });

    it('forwards a custom cacheControl instead of the default immutable one', async () => {
      const service = buildService(r2Values);

      await service.write('cms/covers', '42', buildFile(), 'public, max-age=300, must-revalidate');

      expect(PutObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({ CacheControl: 'public, max-age=300, must-revalidate' }),
      );
    });

    it('builds the S3 client pointed at the R2 endpoint for the configured account', async () => {
      const service = buildService(r2Values);

      await service.write('user-inline', 'jkl-000', buildFile());

      expect(S3Client).toHaveBeenCalledWith(
        expect.objectContaining({
          region: 'auto',
          endpoint: 'https://acc123.r2.cloudflarestorage.com',
          credentials: { accessKeyId: 'key123', secretAccessKey: 'secret123' },
        }),
      );
    });

    it('reuses the same S3 client across successive uploads when credentials are unchanged', async () => {
      const service = buildService(r2Values);

      await service.write('user-inline', 'a', buildFile());
      await service.write('user-inline', 'b', buildFile());

      expect(S3Client).toHaveBeenCalledTimes(1);
    });

    it('publicUrl builds the URL from the base, namespace and filename (trailing slash stripped)', () => {
      const service = buildService(r2Values);

      expect(service.publicUrl('user-inline', 'ghi-789.png')).toBe('https://images.example.com/user-inline/ghi-789.png');
    });

    it('throws a clear error when R2 credentials are incomplete, rather than failing silently', async () => {
      const service = buildService({ common_storage_provider: 'r2', common_storage_r2_bucket: 'my-bucket' });

      await expect(service.write('user-inline', 'incomplete', buildFile())).rejects.toThrow(/identifiants/);
    });
  });
});
