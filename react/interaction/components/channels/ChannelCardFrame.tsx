/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useState, type ReactNode } from 'react';
import type { InteractionApiError, InteractionChannelDto } from '../../types/interactionTypes';
import { channelState } from '../../pure/channelState';
import { IxLabel } from '../IxText';

export interface ChannelActions {
  setState: (kind: string, state: { enabled?: boolean; position?: number }) => Promise<void>;
  remove: (kind: string) => Promise<void>;
  test: (kind: string) => Promise<{ ok: boolean; code: string | null }>;
}

/**
 * The common frame of a channel card: title, state, owner switch, test, removal. A channel an administrator disabled
 * is explained and its switch / removal are off (the server refuses them anyway, invariant 9).
 */
export function ChannelCardFrame({ channel, actions, children }: { channel: InteractionChannelDto; actions: ChannelActions; children?: ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const state = channelState(channel);
  const run = async (work: () => Promise<string | null>) => {
    setBusy(true);
    setResult(null);
    try {
      setResult(await work());
    } catch (error) {
      setResult(`interaction.errors.${(error as InteractionApiError).code ?? 'UNKNOWN'}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="ix-channel-card" aria-busy={busy}>
      <header className="ix-channel-card-header">
        <h4><IxLabel id={`interaction.channels.${channel.kind}.title`} /></h4>
        <span className={`ix-channel-state ix-channel-state--${state.tone}`}><IxLabel id={state.key} /></span>
      </header>
      {channel.adminDisabled ? <p className="ix-muted"><IxLabel id="interaction.channels.adminDisabledHelp" /></p> : null}
      {children}
      {channel.configured ? (
        <div className="ix-channel-card-actions">
          <label className="ix-switch">
            <input
              type="checkbox"
              checked={channel.enabled && !channel.adminDisabled}
              disabled={busy || channel.adminDisabled}
              onChange={(event) => void run(async () => (await actions.setState(channel.kind, { enabled: event.target.checked }), null))}
            />
            <IxLabel id="interaction.channels.enabled" />
          </label>
          <button type="button" className="ix-link-button" disabled={busy || channel.adminDisabled || !channel.ready} onClick={() => void run(async () => ((await actions.test(channel.kind)).ok ? 'interaction.channels.testOk' : 'interaction.channels.testFailed'))}>
            <IxLabel id="interaction.channels.test" />
          </button>
          <button type="button" className="ix-link-button ix-link-button--danger" disabled={busy || channel.adminDisabled} onClick={() => void run(async () => (await actions.remove(channel.kind), null))}>
            <IxLabel id="interaction.channels.remove" />
          </button>
        </div>
      ) : null}
      {channel.lastError ? <p className="ix-muted"><IxLabel id="interaction.channels.lastError" params={{ code: channel.lastError }} /></p> : null}
      {result ? <p className="ix-muted" role="status"><IxLabel id={result} /></p> : null}
    </article>
  );
}
