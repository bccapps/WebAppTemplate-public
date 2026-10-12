/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createSecretKey, hkdfSync, randomBytes } from 'crypto';
import { deflateSync, inflateSync } from 'zlib';
import {
  STORAGE_PAYLOAD_VERSION,
  TRANSPORT_PAYLOAD_VERSION,
  TRANSPORT_PAYLOAD_VERSION_LEGACY,
  STORAGE_SALT_FALLBACK,
  TRANSPORT_HKDF_INFO,
  TRANSPORT_PAYLOAD_SEPARATOR,
  TRANSPORT_PAYLOAD_FLAG_NONE,
  TRANSPORT_PAYLOAD_FLAG_DEFLATE,
} from '../constants/crypt.constants';

interface TransportPayloadPartsV1 {
  version: string;
  iv: string;
  cipher: string;
  tag: string;
}

/** Structurally discriminated from v1 by the presence of `flag` (narrow with `'flag' in parts`) —
 *  version is typed as plain `string` on both variants (not the literal const type) so a runtime
 *  mismatch is a validated error, not a compile-time impossibility. */
interface TransportPayloadPartsV2 extends TransportPayloadPartsV1 {
  flag: string;
}

type TransportPayloadParts = TransportPayloadPartsV1 | TransportPayloadPartsV2;

export interface EncryptForTransportOptions {
  /**
   * Emit the legacy v1 wire format (4 segments, no compression flag, never
   * compressed) instead of the current v2 format. Used for clients that
   * haven't announced v2 support via TRANSPORT_ACCEPT_ENCODING_HEADER (see
   * TransportCryptInterceptor) — e.g. a front bundle cached from before this
   * rollout.
   */
  legacy?: boolean;
  /** Deflate the JSON payload before encrypting it, when it's at least `thresholdBytes` long.
   *  Ignored when `legacy` is true. */
  deflate?: boolean;
  /** Minimum plaintext size (bytes) above which `deflate` actually kicks in — below it the
   *  CPU cost of deflating outweighs the bytes saved on the wire. Defaults to 0 (always
   *  compress when `deflate` is requested) so callers that don't pass it keep prior behavior. */
  thresholdBytes?: number;
}

@Injectable()
export class CryptService {
  private readonly storageMasterKey: Buffer;
  private readonly storageDerivationSalt: Buffer;

  constructor() {
    const masterKeyInput = process.env.CRYPT_DB_MASTER_KEY;
    if (!masterKeyInput) {
      throw new Error(
        `[CryptService] Missing CRYPT_DB_MASTER_KEY. Provide a 32-byte key encoded as base64 or hex.`,
      );
    }

    const masterKey = this.decodeKey(masterKeyInput);
    if (masterKey.length < 32) {
      throw new Error(
        `[CryptService] CRYPT_DB_MASTER_KEY must decode to at least 32 bytes. Current length=${masterKey.length}.`,
      );
    }
    this.storageMasterKey = masterKey;

    const saltInput = process.env.CRYPT_DB_DERIVATION_SALT ?? STORAGE_SALT_FALLBACK;
    this.storageDerivationSalt = Buffer.from(saltInput, 'utf8');
  }

  encryptForStorage<T>(value: T, namespace = 'default'): string {
    const payload = Buffer.from(JSON.stringify({ v: value }), 'utf8');
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = this.deriveStorageKey(namespace, salt);

    const cipher = createCipheriv('aes-256-gcm', this.toKeyObject(key), this.toBinaryLike(iv));
    cipher.setAAD(Buffer.from(namespace, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
    const tag = cipher.getAuthTag();

    return [
      STORAGE_PAYLOAD_VERSION,
      this.toBase64(salt),
      this.toBase64(iv),
      this.toBase64(tag),
      this.toBase64(ciphertext),
    ].join(
      ':',
    );
  }

  decryptFromStorage<T = unknown>(payload: string, namespace = 'default'): T {
    const parts = payload.split(':');
    if (parts.length !== 5) {
      throw new Error('[CryptService] Invalid storage payload format');
    }
    const [version, saltB64, ivB64, tagB64, cipherB64] = parts;
    if (version !== STORAGE_PAYLOAD_VERSION) {
      throw new Error(`[CryptService] Unsupported storage payload version: ${version}`);
    }

    const salt = this.fromBase64(saltB64);
    const iv = this.fromBase64(ivB64);
    const tag = this.fromBase64(tagB64);
    const cipher = this.fromBase64(cipherB64);

    const key = this.deriveStorageKey(namespace, salt);
    const decipher = createDecipheriv('aes-256-gcm', this.toKeyObject(key), this.toBinaryLike(iv));
    decipher.setAAD(Buffer.from(namespace, 'utf8'));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(cipher), decipher.final()]);
    const parsed = JSON.parse(plaintext.toString('utf8'));
    return (parsed?.v ?? null) as T;
  }

  encryptForTransport<T>(value: T, sessionKey: Buffer, options?: EncryptForTransportOptions): string {
    this.ensureSessionKey(sessionKey);
    const json = Buffer.from(JSON.stringify({ v: value }), 'utf8');
    const legacy = options?.legacy === true;

    let plaintext = json;
    let flag = TRANSPORT_PAYLOAD_FLAG_NONE;
    if (!legacy && options?.deflate && json.byteLength >= (options.thresholdBytes ?? 0)) {
      // zlib format (RFC1950) — matches the browser's DecompressionStream('deflate'),
      // NOT the raw RFC1951 stream ('deflate-raw'). See CryptService.spec.ts for the
      // round-trip test that pins this down (a mismatch here breaks decryption silently).
      plaintext = deflateSync(json);
      flag = TRANSPORT_PAYLOAD_FLAG_DEFLATE;
    }

    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.toKeyObject(sessionKey), this.toBinaryLike(iv));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    if (legacy) {
      return this.serializeTransportPayload({
        version: TRANSPORT_PAYLOAD_VERSION_LEGACY,
        iv: this.toBase64(iv),
        cipher: this.toBase64(ciphertext),
        tag: this.toBase64(tag),
      });
    }
    return this.serializeTransportPayload({
      version: TRANSPORT_PAYLOAD_VERSION,
      flag,
      iv: this.toBase64(iv),
      cipher: this.toBase64(ciphertext),
      tag: this.toBase64(tag),
    });
  }

  decryptFromTransport<T = unknown>(payload: string, sessionKey: Buffer): T {
    this.ensureSessionKey(sessionKey);
    const parts = this.parseTransportPayload(payload);

    const iv = this.fromBase64(parts.iv);
    const ciphertext = this.fromBase64(parts.cipher);
    const tag = this.fromBase64(parts.tag);

    const decipher = createDecipheriv('aes-256-gcm', this.toKeyObject(sessionKey), this.toBinaryLike(iv));
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    const plaintext = 'flag' in parts && parts.flag === TRANSPORT_PAYLOAD_FLAG_DEFLATE
      ? inflateSync(decrypted)
      : decrypted;

    const parsed = JSON.parse(plaintext.toString('utf8'));
    return (parsed?.v ?? null) as T;
  }

  private deriveStorageKey(namespace: string, salt: Buffer): Buffer {
    const scopedSalt = Buffer.concat([salt, this.storageDerivationSalt]);
    const info = Buffer.from(`web3c:db:${namespace}`, 'utf8');
    const derived = hkdfSync('sha256', this.storageMasterKey, scopedSalt, info, 32);
    return Buffer.isBuffer(derived) ? derived : Buffer.from(derived);
  }

  private ensureSessionKey(key: Buffer) {
    if (key.length !== 32) {
      throw new Error('[CryptService] Transport session key must be 32 bytes');
    }
  }

  private toKeyObject(buffer: Buffer) {
    return createSecretKey(buffer);
  }

  private toBinaryLike(buffer: Buffer): Uint8Array {
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  private serializeTransportPayload(parts: TransportPayloadParts): string {
    if ('flag' in parts) {
      return [parts.version, parts.flag, parts.iv, parts.cipher, parts.tag].join(TRANSPORT_PAYLOAD_SEPARATOR);
    }
    return [parts.version, parts.iv, parts.cipher, parts.tag].join(TRANSPORT_PAYLOAD_SEPARATOR);
  }

  /** Self-descriptive: a 4-segment payload is always v1 (legacy, never compressed), a
   *  5-segment payload is always v2 (current, carries a compression flag). */
  private parseTransportPayload(payload: string): TransportPayloadParts {
    const segments = payload.split(TRANSPORT_PAYLOAD_SEPARATOR);
    if (segments.length === 4) {
      const [version, iv, cipher, tag] = segments;
      if (version !== TRANSPORT_PAYLOAD_VERSION_LEGACY) {
        throw new Error(`[CryptService] Unsupported transport payload version: ${version}`);
      }
      return { version, iv, cipher, tag };
    }
    if (segments.length === 5) {
      const [version, flag, iv, cipher, tag] = segments;
      if (version !== TRANSPORT_PAYLOAD_VERSION) {
        throw new Error(`[CryptService] Unsupported transport payload version: ${version}`);
      }
      if (flag !== TRANSPORT_PAYLOAD_FLAG_NONE && flag !== TRANSPORT_PAYLOAD_FLAG_DEFLATE) {
        throw new Error(`[CryptService] Unsupported transport payload compression flag: ${flag}`);
      }
      return { version, flag, iv, cipher, tag };
    }
    throw new Error('[CryptService] Invalid transport payload format');
  }

  private decodeKey(value: string): Buffer {
    const trimmed = value.trim();
    if (!trimmed) {
      return Buffer.alloc(0);
    }

    // Detect hex (only hex chars and even length)
    const isHex = /^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0;
    if (isHex) {
      return Buffer.from(trimmed, 'hex');
    }
    return Buffer.from(trimmed, 'base64');
  }

  private toBase64(buffer: Buffer): string {
    return buffer.toString('base64');
  }

  private fromBase64(value: string): Buffer {
    return Buffer.from(value, 'base64');
  }
}
