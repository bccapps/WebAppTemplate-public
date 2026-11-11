/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { beforeAll, describe, expect, it, jest } from '@jest/globals';
import { CryptService } from '../../common/services/CryptService';
import { BadRequestException } from '@nestjs/common';
import { UserVoiceAccessService } from './UserVoiceAccessService';
import { VoiceAccessService } from './VoiceAccessService';
import { VoiceSecretCipher } from './VoiceSecretCipher';

type Row = Record<string, unknown> & { id: number; username: string | null; password: string | null };

/** In-memory stand-in for a TypeORM repository (the behaviours the services use). */
function fakeRepo(rows: Row[]) {
  return {
    rows,
    create: (value: Record<string, unknown>) => ({ ...value }),
    merge: (target: Row, patch: Record<string, unknown>) => Object.assign(target, patch),
    save: jest.fn(async (value: Row) => {
      const row = value.id ? rows.find((r) => r.id === value.id) : undefined;
      if (row) Object.assign(row, value);
      else rows.push({ ...value, id: rows.length + 1, provider: { id: 1, name: 'P', slug: 'p', type: 'aws-polly', capabilities: ['tts'] } });
      return value.id ? row! : rows[rows.length - 1];
    }),
    findOne: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const found = rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v));
      return found ? { ...found } : null;
    }),
    find: jest.fn(async () => rows.map((r) => ({ ...r }))),
    update: jest.fn(async (where: Record<string, unknown>, patch: Record<string, unknown>) => {
      const found = rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v));
      if (found) Object.assign(found, patch);
      return { affected: found ? 1 : 0 };
    }),
    delete: jest.fn(),
  };
}

let cipher: VoiceSecretCipher;
beforeAll(() => {
  process.env.CRYPT_DB_MASTER_KEY = 'c3'.repeat(32);
  cipher = new VoiceSecretCipher(new CryptService());
});

const legacy = (extra: Partial<Row> = {}): Row => ({
  id: 1, userId: 5, label: 'L', providerId: 1, baseUrlOverride: null, username: 'AKIDLEGACY', password: 'plain-secret', providerConfig: null,
  provider: { id: 1, name: 'P', slug: 'p', type: 'aws-polly', capabilities: ['tts'] }, ...extra,
});

describe('UserVoiceAccessService encryption at rest', () => {
  it('stores credentials sealed on create and returns them in plaintext only through getAccessWithSecrets', async () => {
    const repo = fakeRepo([]);
    const service = new UserVoiceAccessService(repo as never, cipher);
    const view = await service.create(5, { label: 'Mine', providerId: 1, username: 'AKID', password: 'top-secret' });
    expect(cipher.isSealed(repo.rows[0].username)).toBe(true);
    expect(cipher.isSealed(repo.rows[0].password)).toBe(true);
    expect(JSON.stringify(repo.rows[0])).not.toContain('top-secret');
    expect(JSON.stringify(view)).not.toContain('top-secret');
    expect(view).toMatchObject({ username: 'AKID', hasPassword: true });
    expect(view).not.toHaveProperty('password');
    const full = await service.getAccessWithSecrets(5, 1);
    expect(full).toMatchObject({ username: 'AKID', password: 'top-secret' });
    expect(await service.getAccessWithSecrets(6, 1)).toBeNull();
  });

  it('reads a legacy plaintext row and re-encrypts it on read', async () => {
    const repo = fakeRepo([legacy()]);
    const service = new UserVoiceAccessService(repo as never, cipher);
    const full = await service.getAccessWithSecrets(5, 1);
    expect(full).toMatchObject({ username: 'AKIDLEGACY', password: 'plain-secret' });
    expect(cipher.isSealed(repo.rows[0].password)).toBe(true);
    expect(cipher.isSealed(repo.rows[0].username)).toBe(true);
    expect(cipher.open(repo.rows[0].password as string, 'user_voice_accesses', 'password')).toBe('plain-secret');
  });

  it('does not overwrite a value saved concurrently (compare-and-set)', async () => {
    const repo = fakeRepo([legacy()]);
    const service = new UserVoiceAccessService(repo as never, cipher);
    const realFindOne = repo.findOne.getMockImplementation()!;
    // Another save lands between our read and the re-encryption.
    repo.findOne.mockImplementationOnce(async (arg: never) => {
      const read = await realFindOne(arg);
      repo.rows[0].password = cipher.seal('new-secret', 'user_voice_accesses', 'password');
      return read;
    });
    await service.getAccessWithSecrets(5, 1);
    expect(cipher.open(repo.rows[0].password as string, 'user_voice_accesses', 'password')).toBe('new-secret');
  });

  it('seals leftover plaintext on update, keeps the stored secret when none is sent', async () => {
    const repo = fakeRepo([legacy()]);
    const service = new UserVoiceAccessService(repo as never, cipher);
    await service.update(5, 1, { label: 'Renamed', providerId: 1, username: 'AKIDLEGACY' });
    expect(cipher.open(repo.rows[0].password as string, 'user_voice_accesses', 'password')).toBe('plain-secret');
    expect(cipher.isSealed(repo.rows[0].password)).toBe(true);
    await service.update(5, 1, { label: 'Renamed', providerId: 1, username: 'AKIDLEGACY', password: 'rotated' });
    expect(cipher.open(repo.rows[0].password as string, 'user_voice_accesses', 'password')).toBe('rotated');
  });

  it('refuses to point a stored secret at another URL or provider without a new secret', async () => {
    const service = new UserVoiceAccessService(fakeRepo([legacy()]) as never, cipher);
    await expect(service.update(5, 1, { label: 'x', providerId: 1, baseUrlOverride: 'https://other.example.com' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.update(5, 1, { label: 'x', providerId: 2 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.update(5, 1, { label: 'x', providerId: 2, password: 'new' })).resolves.toBeDefined();
  });

  it('refuses a base URL or region that would make the server call somewhere else', async () => {
    const service = new UserVoiceAccessService(fakeRepo([]) as never, cipher);
    for (const baseUrlOverride of ['http://example.com', 'https://127.0.0.1/x', 'https://localhost', 'https://db.internal', 'https://u:p@example.com']) {
      await expect(service.create(5, { label: 'Bad', providerId: 1, baseUrlOverride })).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(service.create(5, { label: 'Bad', providerId: 1, providerConfig: { region: 'evil.com/' } })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create(5, { label: 'Ok', providerId: 1, baseUrlOverride: 'https://polly.eu-west-3.amazonaws.com', providerConfig: { region: 'eu-west-3' } })).resolves.toBeDefined();
  });
});

describe('VoiceAccessService (admin) encryption at rest', () => {
  it('uses its own namespace: a user-table ciphertext does not decrypt as an admin one', async () => {
    const repo = fakeRepo([]);
    const service = new VoiceAccessService(repo as never, cipher);
    await service.create({ label: 'Hub', providerId: 1, password: 'admin-secret' });
    expect(cipher.isSealed(repo.rows[0].password)).toBe(true);
    expect(() => cipher.open(repo.rows[0].password as string, 'user_voice_accesses', 'password')).toThrow();
    expect(await service.getAccessWithSecrets(1)).toMatchObject({ password: 'admin-secret' });
    expect(JSON.stringify(await service.listAll())).not.toContain('admin-secret');
  });

  it('reads and re-encrypts a legacy plaintext admin row', async () => {
    const repo = fakeRepo([legacy({ id: 3 })]);
    const service = new VoiceAccessService(repo as never, cipher);
    expect(await service.getAccessWithSecrets(3)).toMatchObject({ password: 'plain-secret' });
    expect(cipher.open(repo.rows[0].password as string, 'voice_accesses', 'password')).toBe('plain-secret');
  });
});
