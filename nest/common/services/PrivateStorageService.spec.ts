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
    GetObjectCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
    DeleteObjectCommand: jest.fn().mockImplementation((input: unknown) => ({ input })),
  };
});

const s3 = jest.requireMock('@aws-sdk/client-s3') as {
  send: jest.Mock;
  S3Client: jest.Mock;
  PutObjectCommand: jest.Mock;
  GetObjectCommand: jest.Mock;
  DeleteObjectCommand: jest.Mock;
};

import { PrivateStorageService } from './PrivateStorageService';

const buildService = (values: Record<string, string>): PrivateStorageService => {
  const moduleConfigService = { getDecryptedValue: jest.fn((key: string) => values[key] ?? '') };
  return new PrivateStorageService(moduleConfigService as never);
};

describe('PrivateStorageService', () => {
  const tmpDir = path.join(os.tmpdir(), `private-storage-service-spec-${Date.now()}`);

  beforeEach(() => {
    process.env.APP_DATA_DIR = tmpDir;
    jest.clearAllMocks();
  });

  afterAll(async () => {
    delete process.env.APP_DATA_DIR;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('local provider (default)', () => {
    it('round-trips bytes under <APP_DATA_DIR>/private/<key>', async () => {
      const service = buildService({});

      await service.put('invoices/A-1.pdf', Buffer.from('pdf-bytes'), 'application/pdf');

      expect((await fs.readFile(path.join(tmpDir, 'private', 'invoices', 'A-1.pdf'))).toString()).toBe('pdf-bytes');
      expect((await service.get('invoices/A-1.pdf'))?.toString()).toBe('pdf-bytes');
      expect(s3.S3Client).not.toHaveBeenCalled();
    });

    it('get returns null for a missing key and remove tolerates it', async () => {
      const service = buildService({});

      expect(await service.get('invoices/missing.pdf')).toBeNull();
      await expect(service.remove('invoices/missing.pdf')).resolves.toBeUndefined();
    });

    it('remove deletes a stored file', async () => {
      const service = buildService({});
      await service.put('commerce/logo/logo.png', Buffer.from('x'), 'image/png');

      await service.remove('commerce/logo/logo.png');

      expect(await service.get('commerce/logo/logo.png')).toBeNull();
    });
  });

  describe('key validation', () => {
    it.each(['', '/abs/path', '../escape', 'a/../b', 'a//b', 'a\\b', './x'])('rejects %j', async (key) => {
      const service = buildService({});

      await expect(service.put(key, Buffer.from('x'), 'text/plain')).rejects.toThrow(/Clé de stockage invalide/);
    });
  });

  describe('r2 provider', () => {
    const r2Values: Record<string, string> = {
      common_private_storage_provider: 'r2',
      common_private_storage_r2_bucket: 'private-bucket',
      common_private_storage_r2_accountId: 'acc-private',
      common_private_storage_r2_accessKeyId: 'key-private',
      common_private_storage_r2_secretAccessKey: 'secret-private',
    };

    it('uploads via PutObjectCommand to the private bucket instead of disk', async () => {
      const service = buildService(r2Values);

      await service.put('invoices/R2-1.pdf', Buffer.from('pdf'), 'application/pdf');

      expect(s3.PutObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({ Bucket: 'private-bucket', Key: 'invoices/R2-1.pdf', ContentType: 'application/pdf' }),
      );
      await expect(fs.access(path.join(tmpDir, 'private', 'invoices', 'R2-1.pdf'))).rejects.toThrow();
    });

    it('points the client at the configured account endpoint', async () => {
      const service = buildService(r2Values);

      await service.put('k/a', Buffer.from('x'), 'text/plain');

      expect(s3.S3Client).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: 'https://acc-private.r2.cloudflarestorage.com',
          credentials: { accessKeyId: 'key-private', secretAccessKey: 'secret-private' },
        }),
      );
    });

    it('falls back to the public-storage account and credentials when the private ones are empty', async () => {
      const service = buildService({
        common_private_storage_provider: 'r2',
        common_private_storage_r2_bucket: 'private-bucket',
        common_storage_r2_accountId: 'acc-public',
        common_storage_r2_accessKeyId: 'key-public',
        common_storage_r2_secretAccessKey: 'secret-public',
      });

      await service.put('k/a', Buffer.from('x'), 'text/plain');

      expect(s3.S3Client).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: 'https://acc-public.r2.cloudflarestorage.com',
          credentials: { accessKeyId: 'key-public', secretAccessKey: 'secret-public' },
        }),
      );
      expect(s3.PutObjectCommand).toHaveBeenCalledWith(expect.objectContaining({ Bucket: 'private-bucket' }));
    });

    it('never falls back to the PUBLIC bucket name', async () => {
      const service = buildService({ ...r2Values, common_private_storage_r2_bucket: '', common_storage_r2_bucket: 'public-bucket' });

      await expect(service.put('k/a', Buffer.from('x'), 'text/plain')).rejects.toThrow(/identifiants/);
    });

    it('get returns the object bytes', async () => {
      const service = buildService(r2Values);
      s3.send.mockResolvedValueOnce({ Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } } as never);

      const result = await service.get('invoices/A-1.pdf');

      expect(result).toEqual(Buffer.from([1, 2, 3]));
      expect(s3.GetObjectCommand).toHaveBeenCalledWith({ Bucket: 'private-bucket', Key: 'invoices/A-1.pdf' });
    });

    it('get returns null on NoSuchKey but rethrows other errors', async () => {
      const service = buildService(r2Values);
      s3.send.mockRejectedValueOnce(Object.assign(new Error('nope'), { name: 'NoSuchKey' }) as never);
      expect(await service.get('invoices/missing.pdf')).toBeNull();

      s3.send.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDenied' }) as never);
      await expect(service.get('invoices/x.pdf')).rejects.toThrow('denied');
    });

    it('remove sends DeleteObjectCommand', async () => {
      const service = buildService(r2Values);

      await service.remove('invoices/A-1.pdf');

      expect(s3.DeleteObjectCommand).toHaveBeenCalledWith({ Bucket: 'private-bucket', Key: 'invoices/A-1.pdf' });
    });

    it('reuses the S3 client while the configuration is unchanged', async () => {
      const service = buildService(r2Values);

      await service.put('k/a', Buffer.from('x'), 'text/plain');
      await service.put('k/b', Buffer.from('x'), 'text/plain');

      expect(s3.S3Client).toHaveBeenCalledTimes(1);
    });
  });
});
