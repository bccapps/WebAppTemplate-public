/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable } from '@nestjs/common';
import { createECDH } from 'crypto';
import { ConfigurationService } from '../../common/services/ConfigurationService';
import { CronLockService } from '../../common/services/CronLockService';
import { ModuleConfigService } from '../../common/services/ModuleConfigService';
import { InteractionError } from '../errors/InteractionError';
import { INTERACTION_MODULE_ID } from '../interactionConfigSchema';
import type { VapidKeySource } from '../types/ports';

const PRIVATE_KEY = 'interaction_vapidPrivateKey';
const PUBLIC_KEY = 'interaction_vapidPublicKey';
const PRIVATE_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** A P-256 key pair in the form `web-push` and `pushManager.subscribe` use (base64url, uncompressed public point). */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const curve = createECDH('prime256v1');
  curve.generateKeys();
  const priv = curve.getPrivateKey();
  const privateKey = (priv.length < 32 ? Buffer.concat([Buffer.alloc(32 - priv.length), priv]) : priv).toString('base64url');
  return { publicKey: curve.getPublicKey().toString('base64url'), privateKey };
}

/** The public half of a private key (so the two can never disagree). */
export function vapidPublicKeyOf(privateKey: string): string {
  const curve = createECDH('prime256v1');
  curve.setPrivateKey(Buffer.from(privateKey, 'base64url'));
  return curve.getPublicKey().toString('base64url');
}

/** Attempts (and wait between them) of an instance that finds another one generating the pair. */
const WAIT_ATTEMPTS = 10;
const WAIT_MS = 200;

/**
 * Default `VapidKeySource` (04 §13): ONE key pair for the app, generated on first use and kept in the module
 * configuration (`interaction_vapidPrivateKey`, a write-only secret, and `interaction_vapidPublicKey`); the public key
 * served is always derived from the stored private key. Review F8, first-use race: generation runs under
 * `CronLockService.runExclusive` (one instance at a time) AND, inside it, the stored value is read FRESH (the common
 * configuration cache keeps a value up to 5 s: a second instance would otherwise not see the pair the first one has
 * just written and overwrite it, breaking every subscription signed with it); an instance that finds the lock taken
 * waits for the pair instead of generating one. `common` has no public reload: an empty `updateModuleConfig` writes
 * nothing and reloads the cache. A stored private key that does not have the expected shape (another master key: the
 * config reader then hands back the ciphertext) fails closed: `SECRET_UNREADABLE`, nothing is signed with it.
 */
@Injectable()
export class ConfigVapidKeySource implements VapidKeySource {
  constructor(
    private readonly moduleConfig: ModuleConfigService,
    private readonly configuration: ConfigurationService,
    private readonly cronLock: CronLockService,
  ) {}

  async keys(): Promise<{ publicKey: string; privateKey: string; subject: string }> {
    let privateKey = this.storedPrivateKey();
    for (let attempt = 0; privateKey === null && attempt < WAIT_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
      await this.cronLock.runExclusive('interaction.vapid', async () => {
        await this.reload();
        if (this.storedPrivateKey() !== null) return;
        const pair = generateVapidKeys();
        await this.moduleConfig.updateModuleConfig(INTERACTION_MODULE_ID, { [PRIVATE_KEY]: pair.privateKey, [PUBLIC_KEY]: pair.publicKey });
      });
      await this.reload();
      privateKey = this.storedPrivateKey();
    }
    if (privateKey === null) throw new InteractionError('NOT_CONFIGURED');
    if (!PRIVATE_SHAPE.test(privateKey)) throw new InteractionError('SECRET_UNREADABLE');
    return { publicKey: vapidPublicKeyOf(privateKey), privateKey, subject: this.subject() };
  }

  /** A fresh read of the stored configuration (not the up-to-5-s cache). */
  private async reload(): Promise<void> {
    await this.moduleConfig.updateModuleConfig(INTERACTION_MODULE_ID, {});
    await this.configuration.getConfiguration();
  }

  /** The stored private key, `null` when none was generated yet. */
  private storedPrivateKey(): string | null {
    const value = this.moduleConfig.getDecryptedSecretValue(INTERACTION_MODULE_ID, PRIVATE_KEY);
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
  }

  /** `interaction_vapidSubject`, else `mailto:` + the sender address of `common`, else a placeholder the push services accept. */
  private subject(): string {
    const configured = String(this.moduleConfig.getResolvedValue('interaction_vapidSubject') ?? '').trim();
    if (/^(mailto:|https:\/\/)/.test(configured)) return configured;
    const from = String(this.moduleConfig.getResolvedValue('common_email_fromAddress') ?? '').trim();
    return /^[^\s@]+@[^\s@]+$/.test(from) ? `mailto:${from}` : 'mailto:admin@localhost';
  }
}
