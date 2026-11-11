/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * `InteractionKeyService` copies `CryptService`'s decoding of `CRYPT_DB_MASTER_KEY` and its salt fallback (the lot may not
 * modify `common`). These specs fail as soon as the two diverge: a ciphertext of the REAL `CryptService` must decrypt
 * with the master key and salt the key service decoded (re-deriving the storage key exactly as `CryptService` does),
 * for hex and base64 keys, with and without `CRYPT_DB_DERIVATION_SALT`; then the purpose keys are checked against
 * HKDF(master, salt, info) and against each other (domain separation), and across a master key rotation.
 */
import { afterEach, describe, expect, it } from '@jest/globals';
import { createDecipheriv, createHmac, hkdfSync, randomBytes } from 'crypto';
import { STORAGE_SALT_FALLBACK } from '../../common/constants/crypt.constants';
import { CryptService } from '../../common/services/CryptService';
import { INTERACTION_KEY_INFO, InteractionKeyService } from './InteractionKeyService';

const saved = { key: process.env.CRYPT_DB_MASTER_KEY, salt: process.env.CRYPT_DB_DERIVATION_SALT };

function setEnv(key: string | undefined, salt: string | undefined): void {
  if (key === undefined) delete process.env.CRYPT_DB_MASTER_KEY;
  else process.env.CRYPT_DB_MASTER_KEY = key;
  if (salt === undefined) delete process.env.CRYPT_DB_DERIVATION_SALT;
  else process.env.CRYPT_DB_DERIVATION_SALT = salt;
}

afterEach(() => setEnv(saved.key, saved.salt));

/** What the key service decoded (private fields of this module's own class). */
function decodedBy(service: InteractionKeyService): { master: Buffer; salt: Buffer } {
  const internals = service as unknown as { master: Buffer; salt: Buffer };
  return { master: internals.master, salt: internals.salt };
}

/** Decrypts a `CryptService.encryptForStorage` payload with a given master key and salt, re-deriving its key the way `CryptService` does. */
function decryptWith(payload: string, namespace: string, master: Buffer, salt: Buffer): unknown {
  const [version, saltB64, ivB64, tagB64, cipherB64] = payload.split(':');
  expect(version).toBeDefined();
  const key = Buffer.from(hkdfSync('sha256', master, Buffer.concat([Buffer.from(saltB64, 'base64'), salt]), Buffer.from(`web3c:db:${namespace}`, 'utf8'), 32));
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAAD(Buffer.from(namespace, 'utf8'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(cipherB64, 'base64')), decipher.final()]);
  return (JSON.parse(plain.toString('utf8')) as { v: unknown }).v;
}

const raw = randomBytes(32);
const cases: Array<{ name: string; key: string; salt: string | undefined }> = [
  { name: 'hex key, salt fallback', key: raw.toString('hex'), salt: undefined },
  { name: 'hex key (upper case, surrounded by blanks), explicit salt', key: `  ${raw.toString('hex').toUpperCase()}\n`, salt: 'app-specific-salt' },
  { name: 'base64 key, salt fallback', key: raw.toString('base64'), salt: undefined },
  { name: 'base64 key, explicit salt', key: raw.toString('base64'), salt: 'another-salt' },
  { name: 'base64url key, salt fallback', key: randomBytes(48).toString('base64url'), salt: undefined },
  { name: 'odd-length hex (decoded as base64 by both), empty salt', key: `${randomBytes(40).toString('hex')}a`, salt: '' },
];

describe('InteractionKeyService ≡ CryptService (master key decoding and salt)', () => {
  for (const testCase of cases) {
    it(`decodes the master key and the salt exactly like CryptService: ${testCase.name}`, () => {
      setEnv(testCase.key, testCase.salt);
      const crypt = new CryptService();
      const keys = new InteractionKeyService();
      const { master, salt } = decodedBy(keys);
      expect(salt.toString('utf8')).toBe(testCase.salt ?? STORAGE_SALT_FALLBACK);
      // The behavioural proof: CryptService's ciphertext opens with what the key service decoded.
      const namespace = 'interaction:secret:00000000-0000-4000-8000-000000000001';
      expect(decryptWith(crypt.encryptForStorage('probe-value', namespace), namespace, master, salt)).toBe('probe-value');
      // The purpose keys are HKDF(master, salt, info) with those very inputs.
      expect(keys.callbackKey().equals(Buffer.from(hkdfSync('sha256', master, salt, Buffer.from(INTERACTION_KEY_INFO.callback, 'utf8'), 32)))).toBe(true);
      const webhookKey = Buffer.from(hkdfSync('sha256', master, salt, Buffer.from(INTERACTION_KEY_INFO.webhook, 'utf8'), 32));
      expect(keys.webhookSecret('u7', '4242')).toBe(createHmac('sha256', webhookKey).update('u7|4242', 'utf8').digest('base64url'));
    });
  }

  it('refuses what CryptService refuses (missing, empty, shorter than 32 bytes)', () => {
    for (const key of [undefined, '', '   ', 'ab'.repeat(31), Buffer.alloc(31, 1).toString('base64')]) {
      setEnv(key, undefined);
      expect(() => new CryptService()).toThrow();
      expect(() => new InteractionKeyService()).toThrow(/CRYPT_DB_MASTER_KEY/);
    }
  });

  it('a different master key or salt decodes differently: the probe no longer opens (the check is not vacuous)', () => {
    setEnv(raw.toString('hex'), undefined);
    const payload = new CryptService().encryptForStorage('probe-value', 'ns');
    setEnv(raw.toString('base64'), undefined);
    const sameBytes = decodedBy(new InteractionKeyService());
    expect(decryptWith(payload, 'ns', sameBytes.master, sameBytes.salt)).toBe('probe-value');
    setEnv(raw.toString('hex'), 'other-salt');
    const otherSalt = decodedBy(new InteractionKeyService());
    expect(() => decryptWith(payload, 'ns', otherSalt.master, otherSalt.salt)).toThrow();
    setEnv(randomBytes(32).toString('hex'), undefined);
    const otherKey = decodedBy(new InteractionKeyService());
    expect(() => decryptWith(payload, 'ns', otherKey.master, otherKey.salt)).toThrow();
  });
});

describe('InteractionKeyService: domain separation and rotation', () => {
  it('uses one info label per purpose, none in the storage keys’ `web3c:db:` space', () => {
    const labels = Object.values(INTERACTION_KEY_INFO);
    expect(new Set(labels).size).toBe(labels.length);
    for (const label of labels) expect(label.startsWith('web3c:db:')).toBe(false);
    setEnv(raw.toString('hex'), undefined);
    const keys = new InteractionKeyService();
    const { master, salt } = decodedBy(keys);
    const webhookKey = Buffer.from(hkdfSync('sha256', master, salt, Buffer.from(INTERACTION_KEY_INFO.webhook, 'utf8'), 32));
    expect(keys.callbackKey().equals(webhookKey)).toBe(false);
    // A storage key of a namespace that spells a purpose label (with or without CryptService's random salt) is another key.
    for (const namespace of labels) {
      expect(Buffer.from(hkdfSync('sha256', master, salt, Buffer.from(`web3c:db:${namespace}`, 'utf8'), 32)).equals(keys.callbackKey())).toBe(false);
    }
  });

  it('a rotated master key changes every purpose key (old buttons and webhook secrets stop verifying)', () => {
    setEnv(raw.toString('hex'), undefined);
    const before = new InteractionKeyService();
    setEnv(randomBytes(32).toString('hex'), undefined);
    const after = new InteractionKeyService();
    expect(before.callbackKey().equals(after.callbackKey())).toBe(false);
    expect(before.webhookSecret('u1', '7')).not.toBe(after.webhookSecret('u1', '7'));
    setEnv(raw.toString('hex'), undefined);
    expect(new InteractionKeyService().callbackKey().equals(before.callbackKey())).toBe(true);
  });
});
