/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createCipheriv, randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { CryptService } from './CryptService';
import {
  TRANSPORT_ACCEPT_ENCODING_HEADER,
  TRANSPORT_ENCODING_DEFLATE,
  TRANSPORT_ENCODING_IDENTITY,
  TRANSPORT_PAYLOAD_FLAG_DEFLATE,
  TRANSPORT_PAYLOAD_FLAG_NONE,
  TRANSPORT_PAYLOAD_SEPARATOR,
  TRANSPORT_PAYLOAD_VERSION,
  TRANSPORT_PAYLOAD_VERSION_LEGACY,
} from '../constants/crypt.constants';

/**
 * Builds a transport payload the exact way the nestcommon `CryptService.encryptForTransport`
 * does — using Node's own `zlib`/`crypto` (not the front's WebCrypto). This is the real
 * inter-implementation boundary PERFORMANCE_PLAN.md §2.3 calls out as risky: "une incohérence
 * ici casse tout en silence". If the backend ever switched to `deflateRawSync` (RFC1951) or
 * `gzipSync` (RFC1952) instead of `deflateSync` (RFC1950, what `DecompressionStream('deflate')`
 * expects), this helper would still "work" from Node's perspective but the front's
 * `inflateDeflate` would fail to decode it — which is exactly what these tests catch.
 */
function buildBackendPayload(
  value: unknown,
  rawKey: Buffer,
  options: { legacy?: boolean; deflate?: boolean } = {},
): string {
  const json = Buffer.from(JSON.stringify({ v: value }), 'utf8');
  const legacy = options.legacy === true;

  let plaintext = json;
  let flag = TRANSPORT_PAYLOAD_FLAG_NONE;
  if (!legacy && options.deflate) {
    plaintext = deflateSync(json);
    flag = TRANSPORT_PAYLOAD_FLAG_DEFLATE;
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', rawKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const b64 = (b: Buffer) => b.toString('base64');

  if (legacy) {
    return [TRANSPORT_PAYLOAD_VERSION_LEGACY, b64(iv), b64(ciphertext), b64(tag)].join(TRANSPORT_PAYLOAD_SEPARATOR);
  }
  return [TRANSPORT_PAYLOAD_VERSION, flag, b64(iv), b64(ciphertext), b64(tag)].join(TRANSPORT_PAYLOAD_SEPARATOR);
}

/** `decryptTransport` is private — this is the standard, type-safe way to reach it from a
 *  test: a structural cast to an interface exposing just that method, no `any` involved. */
interface CryptServiceTestAccess {
  decryptTransport<T = unknown>(payload: string, key: CryptoKey): Promise<T>;
}

describe('CryptService (front) — transport decrypt + decompression (PERFORMANCE_PLAN.md §2.3)', () => {
  const cryptService = new CryptService();
  const decryptTransport = <T = unknown>(payload: string, key: CryptoKey): Promise<T> =>
    (cryptService as unknown as CryptServiceTestAccess).decryptTransport<T>(payload, key);
  const bigValue = { series: Array.from({ length: 500 }, (_, i) => ({ t: i, v: 42.5 })) };

  let rawKey: Buffer;
  let cryptoKey: CryptoKey;

  beforeEach(async () => {
    rawKey = randomBytes(32);
    cryptoKey = await crypto.subtle.importKey('raw', new Uint8Array(rawKey), 'AES-GCM', false, ['decrypt']);
  });

  it('decrypts and inflates a v2 payload deflated by Node zlib — the real inter-implementation round trip', async () => {
    const payload = buildBackendPayload(bigValue, rawKey, { deflate: true });
    const decrypted = await decryptTransport(payload, cryptoKey);
    expect(decrypted).toEqual(bigValue);
  });

  it('decrypts a v2 payload with compression disabled', async () => {
    const payload = buildBackendPayload(bigValue, rawKey, { deflate: false });
    const segments = payload.split(TRANSPORT_PAYLOAD_SEPARATOR);
    expect(segments).toHaveLength(5);
    expect(segments[1]).toBe(TRANSPORT_PAYLOAD_FLAG_NONE);
    const decrypted = await decryptTransport(payload, cryptoKey);
    expect(decrypted).toEqual(bigValue);
  });

  it('decrypts a legacy v1 payload — old-format backend, or mid-rollout replica', async () => {
    const payload = buildBackendPayload(bigValue, rawKey, { legacy: true });
    expect(payload.split(TRANSPORT_PAYLOAD_SEPARATOR)).toHaveLength(4);
    const decrypted = await decryptTransport(payload, cryptoKey);
    expect(decrypted).toEqual(bigValue);
  });

  it('rejects a payload carrying an unsupported version', async () => {
    const payload = buildBackendPayload(bigValue, rawKey, { deflate: false });
    const segments = payload.split(TRANSPORT_PAYLOAD_SEPARATOR);
    segments[0] = 'v99';
    const tampered = segments.join(TRANSPORT_PAYLOAD_SEPARATOR);
    await expect(decryptTransport(tampered, cryptoKey)).rejects.toThrow(
      /Unsupported transport payload version/,
    );
  });

  describe('capability negotiation header', () => {
    const originalDecompressionStream = globalThis.DecompressionStream;

    afterEach(() => {
      globalThis.DecompressionStream = originalDecompressionStream;
    });

    it('announces deflate support when DecompressionStream is available (this test environment: Node 18+)', () => {
      expect(cryptService.getTransportCapabilityHeaders()).toEqual({
        [TRANSPORT_ACCEPT_ENCODING_HEADER]: TRANSPORT_ENCODING_DEFLATE,
      });
    });

    it('announces identity (no compression) when DecompressionStream is unavailable — the ~4% fallback', () => {
      // @ts-expect-error simulating a browser without DecompressionStream (~4% of traffic)
      delete globalThis.DecompressionStream;
      expect(cryptService.getTransportCapabilityHeaders()).toEqual({
        [TRANSPORT_ACCEPT_ENCODING_HEADER]: TRANSPORT_ENCODING_IDENTITY,
      });
    });

    it('throws instead of silently mis-decoding if a compressed payload arrives without decompression support', async () => {
      const payload = buildBackendPayload(bigValue, rawKey, { deflate: true });
      // @ts-expect-error simulating a browser without DecompressionStream (~4% of traffic)
      delete globalThis.DecompressionStream;
      await expect(decryptTransport(payload, cryptoKey)).rejects.toThrow(
        /DecompressionStream is unavailable/,
      );
    });
  });
});
