/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/** The `proof` capability at registration (04 §22): declared by every provider, `code` refused unless explicitly allowed. */
import { describe, expect, it } from '@jest/globals';
import type { InteractionProof } from '../types/interactionTypes';
import type { InteractionChannelProvider } from '../types/providerTypes';
import { InteractionConfig } from './InteractionConfig';
import { InteractionProviderRegistry } from './InteractionProviderRegistry';

const config = { enabledKinds: () => ['telegram', 'hubchat', 'otp'], telegramMode: () => 'own' } as unknown as InteractionConfig;

function provider(kind: string, proof: unknown, reply = true): InteractionChannelProvider {
  return { kind, proof, capabilities: new Set(reply ? (['notify', 'reply'] as const) : (['notify'] as const)) } as unknown as InteractionChannelProvider;
}

const registry = (providers: InteractionChannelProvider[], allowCodeProof = false) => new InteractionProviderRegistry([], providers, config, { allowCodeProof });

describe('InteractionProviderRegistry: proof capability', () => {
  it('knows each kind’s declared proof (`inapp`: in_app) and hands it to answerableKinds', () => {
    const reg = registry([provider('telegram', 'link'), provider('hubchat', 'in_app'), provider('browser', 'link', false)]);
    expect([reg.proofOf('inapp'), reg.proofOf('telegram'), reg.proofOf('hubchat'), reg.proofOf('browser'), reg.proofOf('unknown')]).toEqual(['in_app', 'link', 'in_app', 'link', null]);
    expect(reg.answerChannels()).toEqual([
      { kind: 'inapp', reply: true, proof: 'in_app' },
      { kind: 'telegram', reply: true, proof: 'link' },
      { kind: 'hubchat', reply: true, proof: 'in_app' },
      { kind: 'browser', reply: false, proof: 'link' },
    ]);
  });

  it('refuses a provider declaring `code` unless forRoot({ allowCodeProof: true })', () => {
    expect(() => registry([provider('otp', 'code')])).toThrow(/proof: 'code'.*allowCodeProof/);
    expect(registry([provider('otp', 'code')], true).proofOf('otp')).toBe('code');
  });

  it('refuses a provider without a valid proof declaration', () => {
    for (const proof of [undefined, null, '', 'IN_APP', 'none', 1, true]) expect(() => registry([provider('hubchat', proof as InteractionProof)])).toThrow(/must declare proof/);
  });
});
