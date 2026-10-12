/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, expect, it, beforeEach } from '@jest/globals';
import { createDecipheriv, randomBytes } from 'crypto';
import { inflateSync } from 'zlib';
import { CryptService } from './CryptService';
import {
  TRANSPORT_PAYLOAD_FLAG_DEFLATE,
  TRANSPORT_PAYLOAD_FLAG_NONE,
  TRANSPORT_PAYLOAD_SEPARATOR,
  TRANSPORT_PAYLOAD_VERSION,
  TRANSPORT_PAYLOAD_VERSION_LEGACY,
} from '../constants/crypt.constants';

describe('CryptService — transport (compress-then-encrypt, PERFORMANCE_PLAN.md §2.3)', () => {
  let service: CryptService;
  let sessionKey: Buffer;

  beforeEach(() => {
    process.env.CRYPT_DB_MASTER_KEY = randomBytes(32).toString('base64');
    delete process.env.CRYPT_DB_DERIVATION_SALT;
    service = new CryptService();
    sessionKey = randomBytes(32);
  });

  // A payload well above any sane threshold, whose repetition makes deflate's win obvious
  // and whose JSON compresses reliably (guards against flaky "did it actually shrink?" asserts).
  const bigValue = { series: Array.from({ length: 500 }, (_, i) => ({ t: i, v: 42.5 })) };
  const smallValue = { ok: true };

  it('round-trips with compression requested and above threshold', () => {
    const payload = service.encryptForTransport(bigValue, sessionKey, { deflate: true, thresholdBytes: 64 });
    expect(payload.split(TRANSPORT_PAYLOAD_SEPARATOR)).toHaveLength(5);
    expect(payload.startsWith(`${TRANSPORT_PAYLOAD_VERSION}${TRANSPORT_PAYLOAD_SEPARATOR}${TRANSPORT_PAYLOAD_FLAG_DEFLATE}`)).toBe(true);
    expect(service.decryptFromTransport(payload, sessionKey)).toEqual(bigValue);
  });

  it('round-trips with compression disabled (client did not announce support)', () => {
    const payload = service.encryptForTransport(bigValue, sessionKey, { deflate: false });
    const segments = payload.split(TRANSPORT_PAYLOAD_SEPARATOR);
    expect(segments).toHaveLength(5);
    expect(segments[1]).toBe(TRANSPORT_PAYLOAD_FLAG_NONE);
    expect(service.decryptFromTransport(payload, sessionKey)).toEqual(bigValue);
  });

  it('does not compress a payload under the configured threshold even when deflate is requested', () => {
    const uncompressedPayload = service.encryptForTransport(smallValue, sessionKey, {
      deflate: true,
      thresholdBytes: 1024,
    });
    const segments = uncompressedPayload.split(TRANSPORT_PAYLOAD_SEPARATOR);
    expect(segments[1]).toBe(TRANSPORT_PAYLOAD_FLAG_NONE);
    expect(service.decryptFromTransport(uncompressedPayload, sessionKey)).toEqual(smallValue);
  });

  it('produces a smaller ciphertext when deflate is applied to a compressible payload', () => {
    const compressed = service.encryptForTransport(bigValue, sessionKey, { deflate: true, thresholdBytes: 0 });
    const uncompressed = service.encryptForTransport(bigValue, sessionKey, { deflate: false });
    expect(compressed.length).toBeLessThan(uncompressed.length);
  });

  it('writes the legacy v1 4-segment format when the caller requests it (unannounced/old client)', () => {
    const payload = service.encryptForTransport(bigValue, sessionKey, { legacy: true, deflate: true });
    const segments = payload.split(TRANSPORT_PAYLOAD_SEPARATOR);
    expect(segments).toHaveLength(4);
    expect(segments[0]).toBe(TRANSPORT_PAYLOAD_VERSION_LEGACY);
    // legacy format never compresses even if `deflate: true` was (incorrectly) passed alongside it
    expect(service.decryptFromTransport(payload, sessionKey)).toEqual(bigValue);
  });

  it('still decrypts a payload produced with the default (no options) call — back-compat for existing callers', () => {
    const payload = service.encryptForTransport(bigValue, sessionKey);
    expect(service.decryptFromTransport(payload, sessionKey)).toEqual(bigValue);
  });

  it('rejects a payload with an unsupported version', () => {
    const payload = service.encryptForTransport(bigValue, sessionKey);
    const segments = payload.split(TRANSPORT_PAYLOAD_SEPARATOR);
    segments[0] = 'v99';
    expect(() => service.decryptFromTransport(segments.join(TRANSPORT_PAYLOAD_SEPARATOR), sessionKey)).toThrow(
      /Unsupported transport payload version/,
    );
  });

  it('uses zlib deflate (RFC1950), not raw deflate — the exact format DecompressionStream(\'deflate\') expects', () => {
    const payload = service.encryptForTransport(bigValue, sessionKey, { deflate: true, thresholdBytes: 0 });
    const segments = payload.split(TRANSPORT_PAYLOAD_SEPARATOR);
    expect(segments[1]).toBe(TRANSPORT_PAYLOAD_FLAG_DEFLATE);

    // Decrypt manually (bypassing decryptFromTransport's own inflate) to assert independently
    // that the compressed bytes are genuinely zlib-wrapped deflate, not raw deflate or gzip.
    const [, , ivB64, cipherB64, tagB64] = segments;
    const decipher = createDecipheriv('aes-256-gcm', sessionKey, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(cipherB64, 'base64')), decipher.final()]);
    // inflateSync (zlib/RFC1950) must succeed; inflateRawSync would throw or mis-decode this input.
    const inflated = inflateSync(decrypted);
    expect(JSON.parse(inflated.toString('utf8'))).toEqual({ v: bigValue });
  });
});
