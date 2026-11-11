/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, expect, it, jest } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { VoiceAccessService } from './VoiceAccessService';
import type { VoiceAccessEntity } from '../entities/VoiceAccessEntity';

type Row = Partial<VoiceAccessEntity> & { id: number };

/** A repository double holding one stored access; `merge` behaves like TypeORM's (assigns the patch onto the row). */
function makeService(stored: Row) {
  const row = { ...stored };
  const repo = {
    findOne: jest.fn(async () => row),
    merge: jest.fn((target: Row, patch: Partial<Row>) => Object.assign(target, patch)),
    save: jest.fn(async (value: Row) => value),
  };
  // Identity cipher: sealing at rest is covered by VoiceSecretCipher.spec / UserVoiceAccessService.spec; this spec checks the destination rule.
  const cipher = {
    sealCredentials: <T>(value: T) => value,
    openOrNull: (value: string | null | undefined) => value ?? null,
  };
  return { service: new VoiceAccessService(repo as never, cipher as never), repo, row };
}

const STORED: Row = {
  id: 1,
  label: 'main',
  providerId: 1,
  baseUrlOverride: 'https://api.example.com/v1',
  username: null,
  password: 'stored-secret',
};

const payload = (extra: Record<string, unknown>) => ({
  label: 'main',
  providerId: 1,
  ...extra,
});

describe('VoiceAccessService.update: the stored secret never follows a changed destination', () => {
  it('refuses a new URL when no new secret is supplied', async () => {
    const { service, repo } = makeService(STORED);
    await expect(service.update(1, payload({ baseUrlOverride: 'https://attacker.example.net/v1' }) as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('refuses a new providerId when no new secret is supplied', async () => {
    const { service, repo } = makeService(STORED);
    await expect(service.update(1, payload({ providerId: 2 }) as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('refuses removing the URL override as well (the destination changes back to the default)', async () => {
    const { service } = makeService(STORED);
    await expect(service.update(1, payload({ baseUrlOverride: null }) as never)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a new URL together with a new secret', async () => {
    const { service, row } = makeService(STORED);
    await service.update(1, payload({ baseUrlOverride: 'https://attacker.example.net/v1', password: 'new-secret' }) as never);
    expect(row.password).toBe('new-secret');
    expect(row.baseUrlOverride).toBe('https://attacker.example.net/v1');
  });

  it('accepts a new URL when the secret is explicitly cleared', async () => {
    const { service, row } = makeService(STORED);
    await service.update(1, payload({ baseUrlOverride: 'https://attacker.example.net/v1', password: '' }) as never);
    expect(row.password).toBeNull();
  });

  it('keeps the secret when only the label changes and the destination stays the same', async () => {
    const { service, row } = makeService(STORED);
    await service.update(1, payload({ label: 'renamed', baseUrlOverride: 'https://api.example.com/v1' }) as never);
    expect(row.label).toBe('renamed');
    expect(row.password).toBe('stored-secret');
  });

  it('lets any change through when no secret is stored', async () => {
    const { service } = makeService({ ...STORED, password: null });
    await expect(service.update(1, payload({ baseUrlOverride: 'https://attacker.example.net/v1' }) as never)).resolves.toBeDefined();
  });
});
