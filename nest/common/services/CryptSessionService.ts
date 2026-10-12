/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable, Logger } from '@nestjs/common';
import { createECDH, hkdfSync, randomUUID } from 'crypto';
import { DEFAULT_SESSION_TTL_MS, TRANSPORT_HKDF_INFO, TRANSPORT_SESSION_SALT } from '../constants/crypt.constants';
import { RedisService } from './RedisService';

const REDIS_KEY_PREFIX = 'crypt:session:';

interface ActiveSession {
  key: Buffer;
  expiresAt: number;
}

@Injectable()
export class CryptSessionService {
  private readonly logger = new Logger(CryptSessionService.name);
  private readonly serverPrivateKey: Buffer;
  private readonly serverPublicKey: Buffer;
  private readonly ttlMs: number;

  /** In-memory fallback when Redis is unavailable */
  private localSessions = new Map<string, ActiveSession>();

  constructor(private readonly redisService: RedisService) {
    const sessionPrivateInput = process.env.CRYPT_SESSION_PRIVATE_KEY;
    if (!sessionPrivateInput) {
      throw new Error(
        `[CryptSessionService] Missing CRYPT_SESSION_PRIVATE_KEY. Provide a 32-byte P-256 private key encoded as base64 or hex.`,
      );
    }
    this.serverPrivateKey = this.decodeKey(sessionPrivateInput);
    if (this.serverPrivateKey.length !== 32) {
      throw new Error(
        `[CryptSessionService] CRYPT_SESSION_PRIVATE_KEY must decode to exactly 32 bytes. Current length=${this.serverPrivateKey.length}`,
      );
    }

    const ttlEnv = Number(process.env.CRYPT_SESSION_TTL_MS ?? DEFAULT_SESSION_TTL_MS);
    this.ttlMs = Number.isFinite(ttlEnv) && ttlEnv > 0 ? ttlEnv : DEFAULT_SESSION_TTL_MS;

    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(this.toBinaryLike(this.serverPrivateKey));
    this.serverPublicKey = ecdh.getPublicKey(undefined, 'uncompressed');

    if (!this.redisService.isConfigured()) {
      this.logger.warn('[CryptSessionService] REDIS_URL not set — using in-memory sessions (not shared across replicas).');
    }

    this.logger.log(
      `[CryptSessionService] Ready. Session TTL=${this.ttlMs}ms, Server public key=${this.serverPublicKey.toString('base64')}`,
    );
  }

  getServerPublicKey(): string {
    return this.serverPublicKey.toString('base64');
  }

  getSessionTtlMs() {
    return this.ttlMs;
  }

  async createSession(clientPublicKeyB64: string) {
    const clientPublicKey = this.decodeKey(clientPublicKeyB64);
    if (clientPublicKey.length !== 65) {
      throw new Error('[CryptSessionService] Client public key must be 65 bytes (uncompressed P-256 key).');
    }

    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(this.toBinaryLike(this.serverPrivateKey));
    const sharedSecret = ecdh.computeSecret(this.toBinaryLike(clientPublicKey));
    const derived = hkdfSync(
      'sha256',
      this.toBinaryLike(sharedSecret),
      this.toBinaryLike(TRANSPORT_SESSION_SALT),
      this.toBinaryLike(TRANSPORT_HKDF_INFO),
      32,
    );
    const sessionKey = Buffer.isBuffer(derived) ? derived : Buffer.from(derived);
    const sessionId = randomUUID();
    const ttlSeconds = Math.ceil(this.ttlMs / 1000);

    await this.storeSession(sessionId, sessionKey, ttlSeconds);

    return {
      sessionId,
      serverPublicKey: this.getServerPublicKey(),
      expiresInMs: this.ttlMs,
    };
  }

  async peekSession(sessionId: string | undefined | null): Promise<ActiveSession | null> {
    if (!sessionId) return null;
    return this.loadSession(sessionId);
  }

  async requireSession(sessionId: string | undefined | null): Promise<ActiveSession> {
    const session = await this.peekSession(sessionId);
    if (!session) {
      throw new Error('[CryptSessionService] Session is missing or expired.');
    }
    return session;
  }

  // ── Redis (shared client — see RedisService) ────────────────────

  private async storeSession(sessionId: string, key: Buffer, ttlSeconds: number): Promise<void> {
    const redis = this.redisService.getClient();
    if (redis) {
      try {
        await redis.set(REDIS_KEY_PREFIX + sessionId, key.toString('base64'), 'EX', ttlSeconds);
        return;
      } catch (err: any) {
        this.logger.warn(`[CryptSessionService] Redis SET failed, storing in-memory: ${err.message}`);
      }
    }
    this.localSessions.set(sessionId, { key, expiresAt: Date.now() + ttlSeconds * 1000 });
    this.scheduleCleanup();
  }

  private async loadSession(sessionId: string): Promise<ActiveSession | null> {
    const redis = this.redisService.getClient();
    if (redis) {
      try {
        const value = await redis.get(REDIS_KEY_PREFIX + sessionId);
        if (!value) return null;
        return { key: Buffer.from(value, 'base64'), expiresAt: 0 };
      } catch (err: any) {
        this.logger.warn(`[CryptSessionService] Redis GET failed, checking in-memory: ${err.message}`);
      }
    }
    const session = this.localSessions.get(sessionId);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.localSessions.delete(sessionId);
      return null;
    }
    return session;
  }

  // ── In-memory cleanup (fallback only) ────────────────────────

  private cleanupHandle: NodeJS.Timeout | null = null;

  private scheduleCleanup() {
    if (this.cleanupHandle) return;
    this.cleanupHandle = setTimeout(() => {
      this.cleanupHandle = null;
      const now = Date.now();
      for (const [sessionId, session] of this.localSessions.entries()) {
        if (session.expiresAt <= now) {
          this.localSessions.delete(sessionId);
        }
      }
    }, this.ttlMs);
    // Never keep the process alive for this alone (a long-running server is already kept
    // alive by its HTTP listener; a short-lived process — tests, scripts — must still exit).
    this.cleanupHandle.unref?.();
  }

  // ── Crypto helpers ───────────────────────────────────────────

  private decodeKey(value: string): Buffer {
    const trimmed = value.trim();
    if (!trimmed) {
      return Buffer.alloc(0);
    }
    const isHex = /^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0;
    if (isHex) {
      return Buffer.from(trimmed, 'hex');
    }
    return Buffer.from(trimmed, 'base64');
  }

  private toBinaryLike(buffer: Buffer): Uint8Array {
    const copy = new Uint8Array(buffer.length);
    copy.set(buffer);
    return copy;
  }
}
