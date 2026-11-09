/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { beforeAll, describe, expect, it } from '@jest/globals';
import { CryptService } from '../../common/services/CryptService';
import { VOICE_SECRET_PREFIX, VoiceSecretCipher } from './VoiceSecretCipher';

let cipher: VoiceSecretCipher;
let previousKey: string | undefined;

beforeAll(() => {
  previousKey = process.env.CRYPT_DB_MASTER_KEY;
  process.env.CRYPT_DB_MASTER_KEY = 'a1'.repeat(32);
  cipher = new VoiceSecretCipher(new CryptService());
  if (previousKey === undefined) delete process.env.CRYPT_DB_MASTER_KEY;
  else process.env.CRYPT_DB_MASTER_KEY = previousKey;
});

describe('VoiceSecretCipher', () => {
  it('round-trips a secret behind the recognisable prefix, never storing it in clear', () => {
    const sealed = cipher.seal('sk-secret-123', 'user_voice_accesses', 'password')!;
    expect(sealed.startsWith(VOICE_SECRET_PREFIX)).toBe(true);
    expect(sealed).not.toContain('sk-secret-123');
    expect(cipher.isSealed(sealed)).toBe(true);
    expect(cipher.open(sealed, 'user_voice_accesses', 'password')).toBe('sk-secret-123');
  });

  it('uses a fresh salt and iv each time, and is idempotent on ciphertext', () => {
    const a = cipher.seal('same', 'voice_accesses', 'password')!;
    const b = cipher.seal('same', 'voice_accesses', 'password')!;
    expect(a).not.toBe(b);
    expect(cipher.seal(a, 'voice_accesses', 'password')).toBe(a);
  });

  it('reads a legacy plaintext value as is', () => {
    expect(cipher.open('legacy-key', 'voice_accesses', 'password')).toBe('legacy-key');
    expect(cipher.hasPlaintext({ username: null, password: 'legacy-key' })).toBe(true);
    expect(cipher.hasPlaintext({ username: null, password: cipher.seal('x', 'voice_accesses', 'password') })).toBe(false);
  });

  it('keeps null and empty values as they are', () => {
    expect(cipher.seal(null, 'voice_accesses', 'password')).toBeNull();
    expect(cipher.seal(undefined, 'voice_accesses', 'password')).toBeNull();
    expect(cipher.seal('', 'voice_accesses', 'password')).toBe('');
    expect(cipher.open(null, 'voice_accesses', 'password')).toBeNull();
    expect(cipher.hasPlaintext({ username: '', password: null })).toBe(false);
  });

  it('refuses a value moved to another table or field (namespace is authenticated), without leaking it', () => {
    const sealed = cipher.seal('sk-secret-123', 'user_voice_accesses', 'password')!;
    expect(() => cipher.open(sealed, 'voice_accesses', 'password')).toThrow(/Cannot decrypt voice_accesses\.password/);
    expect(() => cipher.open(sealed, 'user_voice_accesses', 'username')).toThrow(/Cannot decrypt/);
    try {
      cipher.open(sealed, 'voice_accesses', 'password');
    } catch (error) {
      expect((error as Error).message).not.toContain('sk-secret-123');
      expect((error as Error).message).not.toContain(sealed);
    }
    expect(cipher.openOrNull(sealed, 'voice_accesses', 'password')).toBeNull();
  });

  it('refuses ciphertext written under another master key', () => {
    process.env.CRYPT_DB_MASTER_KEY = 'b2'.repeat(32);
    const other = new VoiceSecretCipher(new CryptService());
    delete process.env.CRYPT_DB_MASTER_KEY;
    const sealed = other.seal('x', 'voice_accesses', 'password')!;
    expect(() => cipher.open(sealed, 'voice_accesses', 'password')).toThrow(/wrong CRYPT_DB_MASTER_KEY/);
  });

  it('seals and opens a credentials pair, leaving absent keys absent', () => {
    const sealed = cipher.sealCredentials({ username: 'AKID', password: 'secret' }, 'voice_accesses');
    expect(cipher.isSealed(sealed.username)).toBe(true);
    expect(cipher.isSealed(sealed.password)).toBe(true);
    expect(cipher.openCredentials(sealed, 'voice_accesses')).toEqual({ username: 'AKID', password: 'secret' });
    expect(Object.keys(cipher.sealCredentials({ username: 'AKID' }, 'voice_accesses'))).toEqual(['username']);
  });
});
