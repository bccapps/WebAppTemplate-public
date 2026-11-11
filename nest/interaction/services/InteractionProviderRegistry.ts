/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { InteractionRuntimeOptions } from '../interactionOptions';
import type { AnswerChannel } from '../pure/validation';
import { CHANNEL_KIND_PATTERN, INTERACTION_PROOFS, type InteractionCapability, type InteractionProof } from '../types/interactionTypes';
import { INTERACTION_EXTRA_PROVIDERS, INTERACTION_OPTIONS } from '../types/ports';
import type { InteractionChannelProvider } from '../types/providerTypes';
import { InteractionConfig } from './InteractionConfig';

/** The built-in providers enabled by `forRoot({ builtIn })` (array). */
export const INTERACTION_BUILT_IN_PROVIDERS = Symbol('INTERACTION_BUILT_IN_PROVIDERS');

/** `inapp` is no provider (no row, no configuration): always in the plan, never disabled (invariant 1). */
export const INAPP_KIND = 'inapp';
export const INAPP_CAPABILITIES: ReadonlySet<InteractionCapability> = new Set<InteractionCapability>(['notify', 'open', 'reply']);
/** The in-app modal is inside the authenticated app: the step-up happens there (04 §22). */
export const INAPP_PROOF: InteractionProof = 'in_app';

/**
 * The channel providers of the app: built-in ones first, then the app's (04 §4.6). One provider per kind; each one
 * declares its `proof` capability (04 §22), and `code` is refused unless `forRoot({ allowCodeProof: true })`.
 */
@Injectable()
export class InteractionProviderRegistry {
  private readonly byKind = new Map<string, InteractionChannelProvider>();

  constructor(
    @Inject(INTERACTION_BUILT_IN_PROVIDERS) builtIns: InteractionChannelProvider[],
    @Inject(INTERACTION_EXTRA_PROVIDERS) extras: InteractionChannelProvider[],
    private readonly config: InteractionConfig,
    @Inject(INTERACTION_OPTIONS) private readonly options: Pick<InteractionRuntimeOptions, 'allowCodeProof'>,
  ) {
    for (const provider of [...builtIns, ...extras]) this.add(provider);
  }

  private add(provider: InteractionChannelProvider): void {
    const kind = String(provider.kind);
    if (kind === INAPP_KIND || !CHANNEL_KIND_PATTERN.test(kind)) throw new Error(`[interaction] invalid channel kind "${kind}"`);
    if (this.byKind.has(kind)) throw new Error(`[interaction] two providers for the channel kind "${kind}"`);
    const proof = (provider as { proof?: unknown }).proof;
    if (typeof proof !== 'string' || !INTERACTION_PROOFS.includes(proof as InteractionProof)) throw new Error(`[interaction] the provider of "${kind}" must declare proof: 'in_app' | 'link' | 'code'`);
    if (proof === 'code' && this.options?.allowCodeProof !== true) throw new Error(`[interaction] the provider of "${kind}" declares proof: 'code', refused unless forRoot({ allowCodeProof: true })`);
    this.byKind.set(kind, provider);
  }

  get(kind: string): InteractionChannelProvider | null {
    return this.byKind.get(kind) ?? null;
  }

  /** Every registered kind (configured or not). */
  kinds(): string[] {
    return [...this.byKind.keys()];
  }

  /** The kinds the app offers now: registered AND in `interaction_enabledKinds` (Telegram: mode not `off`). */
  enabledKinds(): string[] {
    const enabled = this.config.enabledKinds();
    return this.kinds().filter((kind) => enabled.includes(kind) && (kind !== 'telegram' || this.config.telegramMode() !== 'off'));
  }

  capabilitiesOf(kind: string): ReadonlySet<InteractionCapability> {
    if (kind === INAPP_KIND) return INAPP_CAPABILITIES;
    return this.byKind.get(kind)?.capabilities ?? new Set<InteractionCapability>();
  }

  /** The declared `proof` of a kind (`inapp`: `in_app`), null for an unknown kind. */
  proofOf(kind: string): InteractionProof | null {
    if (kind === INAPP_KIND) return INAPP_PROOF;
    return this.byKind.get(kind)?.proof ?? null;
  }

  /** The kinds able to answer a question directly (`reply`), `inapp` first. */
  replyKinds(): string[] {
    return [INAPP_KIND, ...this.kinds().filter((kind) => this.byKind.get(kind)?.capabilities.has('reply'))];
  }

  /** What `answerableKinds` needs: every kind (`inapp` first), whether it may `reply`, and its declared `proof`. */
  answerChannels(): AnswerChannel[] {
    return [{ kind: INAPP_KIND, reply: true, proof: INAPP_PROOF }, ...this.kinds().map((kind) => ({ kind, reply: this.byKind.get(kind)?.capabilities.has('reply') === true, proof: this.byKind.get(kind)?.proof as InteractionProof }))];
  }
}
