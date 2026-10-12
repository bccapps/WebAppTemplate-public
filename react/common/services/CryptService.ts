/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { AxiosResponse } from 'axios';
import {
  STORAGE_PAYLOAD_VERSION,
  TRANSPORT_ACCEPT_ENCODING_HEADER,
  TRANSPORT_ENCODING_DEFLATE,
  TRANSPORT_ENCODING_IDENTITY,
  TRANSPORT_ENCRYPTED_HEADER,
  TRANSPORT_HKDF_INFO,
  TRANSPORT_PAYLOAD_FLAG_DEFLATE,
  TRANSPORT_PAYLOAD_SEPARATOR,
  TRANSPORT_PAYLOAD_VERSION,
  TRANSPORT_PAYLOAD_VERSION_LEGACY,
  TRANSPORT_SESSION_ENDPOINT,
  TRANSPORT_SESSION_SALT,
  TRANSPORT_VERSION_HEADER,
} from '../constants/crypt.constants';
import { configurationService } from './ConfigurationService';

type WrapOptions = {
  skipTransport?: boolean;
};

type SessionState = {
  sessionId: string | null;
  sessionKey: CryptoKey | null;
  sessionExpiresAt: number;
  pendingSession: Promise<void> | null;
};

export class CryptService {
  public preloadKey = 'CryptService';
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();
  private readonly sessions = new Map<string, SessionState>();

  private getSession(baseUrl: string): SessionState {
    let session = this.sessions.get(baseUrl);
    if (!session) {
      session = { sessionId: null, sessionKey: null, sessionExpiresAt: 0, pendingSession: null };
      this.sessions.set(baseUrl, session);
    }
    return session;
  }

  /**
   * Headers to merge into every transport-encrypted request so the server can decide, per
   * request, whether it's talking to a v2-capable client and whether that client can actually
   * decompress a deflated response. See TRANSPORT_ACCEPT_ENCODING_HEADER for the full contract.
   * Stateless and cheap (feature detection only) — callers (HttpService) should call this on
   * every request rather than cache the result once, in case the negotiation logic ever needs
   * to become request-dependent.
   */
  getTransportCapabilityHeaders(): Record<string, string> {
    return {
      [TRANSPORT_ACCEPT_ENCODING_HEADER]: this.supportsDecompression()
        ? TRANSPORT_ENCODING_DEFLATE
        : TRANSPORT_ENCODING_IDENTITY,
    };
  }

  private supportsDecompression(): boolean {
    return typeof DecompressionStream !== 'undefined';
  }

  /** Resolve the base URL for a request URL. Returns the default API URL for local, or the remote base. */
  resolveBaseUrl(requestUrl?: string): string {
    if (requestUrl && (requestUrl.startsWith('http://') || requestUrl.startsWith('https://'))) {
      // Extract origin + path prefix (e.g. https://ctdapi-back.web3c.cc/api/v1)
      try {
        const url = new URL(requestUrl);
        // Find the /api/v… prefix
        const apiMatch = url.pathname.match(/^(\/api\/v\d+)/);
        return url.origin + (apiMatch?.[1] ?? '');
      } catch {
        return configurationService.getApiUrl();
      }
    }
    return configurationService.getApiUrl();
  }

  async init(callback?: () => void) {
    try {
      await this.ensureSession();
    } catch (error) {
      console.warn('[CryptService] Initial session establishment failed, will retry lazily.', error);
    } finally {
      callback?.();
    }
  }

  async wrapRequest<T>(
    factory: (sessionId: string | null) => Promise<T>,
    options?: WrapOptions & { requestUrl?: string },
  ): Promise<T> {
    if (options?.skipTransport) {
      return factory(null);
    }
    const baseUrl = this.resolveBaseUrl(options?.requestUrl);
    await this.ensureSession(baseUrl);
    const session = this.getSession(baseUrl);
    if (!session.sessionId || !session.sessionKey) {
      throw new Error('[CryptService] Session unavailable after initialization.');
    }
    // Capture both before the async factory call — a concurrent session rotation
    // would otherwise overwrite session.sessionKey while the request is in flight,
    // causing the response (encrypted with the old key) to be decrypted with the
    // new key and failing AES-GCM authentication.
    const capturedSessionId = session.sessionId;
    const capturedSessionKey = session.sessionKey;
    try {
      const response = await factory(capturedSessionId);
      return this.processResponse(response, capturedSessionKey);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('[CryptService]')) {
        this.invalidateSession(baseUrl);
      }
      throw error;
    }
  }

  async encryptForStorage<T>(value: T, secret: string): Promise<string> {
    if (!secret || secret.trim().length < 8) {
      throw new Error('[CryptService] Storage secret is required.');
    }
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await this.derivePbkdf2Key(secret, salt);

    const plaintext = this.encoder.encode(JSON.stringify({ v: value }));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: this.toArrayBuffer(iv) },
        key,
        this.toArrayBuffer(plaintext),
      ),
    );

    return [
      STORAGE_PAYLOAD_VERSION,
      this.toBase64(salt),
      this.toBase64(iv),
      this.toBase64(ciphertext),
    ].join(TRANSPORT_PAYLOAD_SEPARATOR);
  }

  async decryptFromStorage<T = unknown>(payload: string, secret: string): Promise<T> {
    if (!secret || secret.trim().length < 8) {
      throw new Error('[CryptService] Storage secret is required.');
    }
    const parts = payload.split(TRANSPORT_PAYLOAD_SEPARATOR);
    if (parts.length !== 4) {
      throw new Error('[CryptService] Invalid storage payload format.');
    }
    const [version, saltB64, ivB64, cipherB64] = parts;
    if (version !== STORAGE_PAYLOAD_VERSION) {
      throw new Error(`[CryptService] Unsupported storage payload version: ${version}`);
    }
    const salt = this.fromBase64(saltB64);
    const iv = this.fromBase64(ivB64);
    const ciphertext = this.fromBase64(cipherB64);
    const key = await this.derivePbkdf2Key(secret, salt);

    let plaintextBytes: ArrayBuffer;
    try {
      plaintextBytes = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: this.toArrayBuffer(iv) },
        key,
        this.toArrayBuffer(ciphertext),
      );
    } catch (error) {
      throw new Error('[CryptService] Unable to decrypt storage payload.');
    }
    const plaintext = this.decoder.decode(new Uint8Array(plaintextBytes));
    const parsed = JSON.parse(plaintext);
    return (parsed?.v ?? null) as T;
  }

  private async ensureSession(baseUrl?: string): Promise<string> {
    const url = baseUrl ?? configurationService.getApiUrl();
    const session = this.getSession(url);
    const now = Date.now();
    if (session.sessionId && session.sessionKey && now < session.sessionExpiresAt - 2000) {
      return session.sessionId;
    }
    if (session.pendingSession) {
      await session.pendingSession;
      if (!session.sessionId) {
        throw new Error('[CryptService] Session could not be established.');
      }
      return session.sessionId;
    }
    session.pendingSession = this.createSession(url).finally(() => {
      session.pendingSession = null;
    });
    await session.pendingSession;
    if (!session.sessionId) {
      throw new Error('[CryptService] Session could not be established.');
    }
    return session.sessionId;
  }

  private async createSession(baseUrl?: string) {
    const url = baseUrl ?? configurationService.getApiUrl();
    const session = this.getSession(url);
    this.invalidateSession(url);
    const clientKeyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveKey', 'deriveBits'],
    );
    const clientPublicKey = await crypto.subtle.exportKey('raw', clientKeyPair.publicKey);
    const clientPublicKeyB64 = this.toBase64(new Uint8Array(clientPublicKey));
    const defaultUrl = configurationService.getApiUrl();
    const isRemote = url !== defaultUrl;
    const sessionEndpoint = url + (url.endsWith('/') ? '' : '/') + TRANSPORT_SESSION_ENDPOINT.replace(/^\//, '');
    const response = await fetch(sessionEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(isRemote ? {} : { credentials: 'include' as RequestCredentials }),
      body: JSON.stringify({ clientPublicKey: clientPublicKeyB64 }),
    });
    if (!response.ok) {
      throw new Error(`[CryptService] Failed to establish cryptographic session with ${url}.`);
    }
    const body = await response.json();
    const sessionId: string = body.sessionId;
    const serverPublicKeyB64: string = body.serverPublicKey;
    const expiresInMs: number = body.expiresInMs ?? body.ttlMs ?? 0;
    if (!sessionId || !serverPublicKeyB64) {
      throw new Error('[CryptService] Invalid session response from server.');
    }

    const serverPublicKeyRaw = this.fromBase64(serverPublicKeyB64);
    const serverPublicKey = await crypto.subtle.importKey(
      'raw',
      this.toArrayBuffer(serverPublicKeyRaw),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    );

    const sharedSecret = (await crypto.subtle.deriveBits(
      { name: 'ECDH', public: serverPublicKey },
      clientKeyPair.privateKey,
      256,
    )) as ArrayBuffer;

    const aesKey = await this.deriveSessionKey(sharedSecret);
    session.sessionId = sessionId;
    session.sessionKey = aesKey;
    session.sessionExpiresAt = Date.now() + Math.max(0, expiresInMs || 0);
  }

  private invalidateSession(baseUrl?: string) {
    const url = baseUrl ?? configurationService.getApiUrl();
    const session = this.getSession(url);
    session.sessionId = null;
    session.sessionKey = null;
    session.sessionExpiresAt = 0;
  }

  private async processResponse<T>(response: T, key: CryptoKey): Promise<T> {
    if (!this.isAxiosResponse(response)) {
      return response;
    }
    if (response.status === 204) {
      return response;
    }
    if (!this.isEncryptedResponse(response)) {
      return response;
    }
    const payload = response.data?.payload;
    if (typeof payload !== 'string') {
      throw new Error('[CryptService] Missing encrypted payload in response.');
    }
    const decrypted = await this.decryptTransport(payload, key);
    (response as AxiosResponse).data = decrypted;
    return response;
  }

  private isAxiosResponse(value: unknown): value is AxiosResponse<any> {
    return (
      typeof value === 'object' &&
      value !== null &&
      'data' in value &&
      'headers' in value
    );
  }

  private isEncryptedResponse(response: AxiosResponse): boolean {
    const headers = response.headers ?? {};
    const encryptedHeader =
      headers[TRANSPORT_ENCRYPTED_HEADER] ??
      headers[TRANSPORT_ENCRYPTED_HEADER.toLowerCase()] ??
      headers[TRANSPORT_ENCRYPTED_HEADER.toUpperCase()];
    const versionHeader =
      headers[TRANSPORT_VERSION_HEADER] ??
      headers[TRANSPORT_VERSION_HEADER.toLowerCase()] ??
      headers[TRANSPORT_VERSION_HEADER.toUpperCase()];
    return (
      encryptedHeader === '1' &&
      (versionHeader === TRANSPORT_PAYLOAD_VERSION || versionHeader === TRANSPORT_PAYLOAD_VERSION_LEGACY)
    );
  }

  /** Self-descriptive: a 4-segment payload is always v1 (legacy, never compressed), a
   *  5-segment payload is always v2 (current, carries a compression flag). Both are accepted
   *  so this bundle keeps working whichever side of a rollout the connected backend is on. */
  private async decryptTransport<T = unknown>(payload: string, key: CryptoKey): Promise<T> {
    const parts = payload.split(TRANSPORT_PAYLOAD_SEPARATOR);
    let version: string;
    let flag: string | null;
    let ivB64: string;
    let cipherB64: string;
    let tagB64: string;
    if (parts.length === 4) {
      [version, ivB64, cipherB64, tagB64] = parts;
      flag = null;
      if (version !== TRANSPORT_PAYLOAD_VERSION_LEGACY) {
        throw new Error(`[CryptService] Unsupported transport payload version: ${version}`);
      }
    } else if (parts.length === 5) {
      [version, flag, ivB64, cipherB64, tagB64] = parts;
      if (version !== TRANSPORT_PAYLOAD_VERSION) {
        throw new Error(`[CryptService] Unsupported transport payload version: ${version}`);
      }
    } else {
      throw new Error('[CryptService] Invalid transport payload format.');
    }

    const iv = this.fromBase64(ivB64);
    const cipher = this.fromBase64(cipherB64);
    const tag = this.fromBase64(tagB64);

    const ciphertextWithTag = new Uint8Array(cipher.length + tag.length);
    ciphertextWithTag.set(cipher, 0);
    ciphertextWithTag.set(tag, cipher.length);

    let plaintextBytes: ArrayBuffer;
    try {
      plaintextBytes = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: this.toArrayBuffer(iv) },
        key,
        this.toArrayBuffer(ciphertextWithTag),
      );
    } catch (error) {
      throw new Error('[CryptService] Unable to decrypt transport payload.');
    }

    let plaintextBuffer = new Uint8Array(plaintextBytes);
    if (flag === TRANSPORT_PAYLOAD_FLAG_DEFLATE) {
      if (!this.supportsDecompression()) {
        // Should never happen: this bundle only ever announces deflate support (via
        // getTransportCapabilityHeaders) when DecompressionStream exists, so the server
        // should never have sent a compressed payload in the first place.
        throw new Error('[CryptService] Received a compressed transport payload but DecompressionStream is unavailable.');
      }
      plaintextBuffer = await this.inflateDeflate(plaintextBuffer);
    }

    const plaintext = this.decoder.decode(plaintextBuffer);
    const parsed = JSON.parse(plaintext);
    return (parsed?.v ?? null) as T;
  }

  /** Inflates a zlib-wrapped deflate stream (RFC1950 — `DecompressionStream('deflate')`), the
   *  exact counterpart of Node's `zlib.deflateSync` used by CryptService.encryptForTransport on
   *  the backend. NOT `'deflate-raw'` (RFC1951) or `'gzip'` (RFC1952) — see crypt.constants.ts. */
  private async inflateDeflate(data: Uint8Array): Promise<Uint8Array> {
    const stream = new DecompressionStream('deflate');
    const writer = stream.writable.getWriter();
    void writer.write(this.toArrayBuffer(data));
    void writer.close();

    const reader = stream.readable.getReader();
    const chunks: Uint8Array[] = [];
    let totalLength = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalLength += value.length;
    }

    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }

  private async derivePbkdf2Key(secret: string, salt: Uint8Array): Promise<CryptoKey> {
    const baseKey = await crypto.subtle.importKey(
      'raw',
      this.encoder.encode(secret),
      'PBKDF2',
      false,
      ['deriveKey'],
    );
    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: this.toArrayBuffer(salt),
        iterations: 250_000,
        hash: 'SHA-256',
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  private async deriveSessionKey(sharedSecret: ArrayBuffer): Promise<CryptoKey> {
    const hkdfKey = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: this.toArrayBuffer(this.encoder.encode(TRANSPORT_SESSION_SALT)),
        info: this.toArrayBuffer(this.encoder.encode(TRANSPORT_HKDF_INFO)),
      },
      hkdfKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  private buildUrl(path: string): string {
    if (path.startsWith('http://') || path.startsWith('https://')) {
      return path;
    }
    const base = configurationService.getApiUrl();
    if (base.endsWith('/') && path.startsWith('/')) {
      return `${base}${path.slice(1)}`;
    }
    if (!base.endsWith('/') && !path.startsWith('/')) {
      return `${base}/${path}`;
    }
    return `${base}${path}`;
  }

  private toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  private fromBase64(encoded: string): Uint8Array {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  private toArrayBuffer(view: Uint8Array): ArrayBuffer {
    const copy = new Uint8Array(view.byteLength);
    copy.set(view);
    return copy.buffer;
  }
}

export const cryptService = new CryptService();

