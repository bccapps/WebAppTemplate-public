/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useState, type FormEvent } from 'react';
import { useBrowserNotificationPermission, useWebPush, type InteractionChannels } from '../../hooks/interactionHooks';
import { ixLabel } from '../../services/labels';
import type { BrowserChannelView, InteractionApiError, InteractionChannelDto, TelegramChannelView, TelegramLinkCodeDto } from '../../types/interactionTypes';
import { IxLabel } from '../IxText';
import { ChannelCardFrame } from './ChannelCardFrame';

interface CardProps {
  channel: InteractionChannelDto;
  api: InteractionChannels;
}

/** Browser: the notification permission of THIS browser, Web Push on this device (needs the app's PWA service worker). */
export function BrowserChannelCard({ channel, api }: CardProps) {
  const { permission, request } = useBrowserNotificationPermission();
  const push = useWebPush();
  const view = channel.view as Partial<BrowserChannelView>;
  return (
    <ChannelCardFrame channel={channel} actions={api}>
      <p className="ix-muted"><IxLabel id={`interaction.channels.browser.permission.${permission}`} /></p>
      {permission === 'default' ? (
        <button type="button" className="ix-action ix-action--neutral" onClick={() => void request()}>
          <IxLabel id="interaction.channels.browser.allow" />
        </button>
      ) : null}
      {push.supported ? (
        <div className="ix-row">
          <span><IxLabel id={push.subscribed ? 'interaction.channels.browser.pushOn' : 'interaction.channels.browser.pushOff'} /></span>
          <button type="button" className="ix-action ix-action--neutral" disabled={push.busy || channel.adminDisabled} onClick={() => void (push.subscribed ? push.disable() : push.enable()).then(api.refetch)}>
            <IxLabel id={push.subscribed ? 'interaction.channels.browser.pushDisable' : 'interaction.channels.browser.pushEnable'} />
          </button>
        </div>
      ) : (
        <p className="ix-muted"><IxLabel id="interaction.channels.browser.pushUnsupported" /></p>
      )}
      {push.error ? <p className="ix-muted" role="alert"><IxLabel id={push.error} /></p> : null}
      {typeof view.subscriptions === 'number' ? <p className="ix-muted"><IxLabel id="interaction.channels.browser.devices" params={{ count: view.subscriptions }} /></p> : null}
    </ChannelCardFrame>
  );
}

/**
 * Telegram: the user's own bot (token from @BotFather, never shown back) or the operator's bot, then « link my
 * account »: a one-time code opens the bot (`t.me/<bot>?start=<code>`); linked accounts can be removed here only.
 */
export function TelegramChannelCard({ channel, api }: CardProps) {
  const view = channel.view as Partial<TelegramChannelView>;
  const modes = view.allowedModes ?? [];
  const [mode, setMode] = useState<'own' | 'operator'>(view.mode ?? modes[0] ?? 'own');
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [link, setLink] = useState<TelegramLinkCodeDto | null>(null);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (mode === 'own' && !token && !view.tokenSet) {
      setMessage('interaction.channels.telegram.tokenRequired');
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      await api.configure('telegram', { mode, ...(mode === 'own' && token ? { token } : {}) });
      setToken('');
      setMessage('interaction.channels.saved');
    } catch (error) {
      setMessage(`interaction.errors.${(error as InteractionApiError).code}`);
    } finally {
      setSaving(false);
    }
  };
  const askCode = async () => {
    setMessage(null);
    try {
      setLink(await api.telegramLinkCode());
    } catch (error) {
      setMessage(`interaction.errors.${(error as InteractionApiError).code}`);
    }
  };
  return (
    <ChannelCardFrame channel={channel} actions={api}>
      <form className="ix-form" onSubmit={(event) => void save(event)} aria-busy={saving}>
        {modes.length > 1 ? (
          <label className="ix-field">
            <span><IxLabel id="interaction.channels.telegram.mode" /></span>
            <select value={mode} disabled={saving || channel.adminDisabled} onChange={(event) => setMode(event.target.value === 'operator' ? 'operator' : 'own')}>
              {modes.map((option) => (
                <option key={option} value={option}>{ixLabel(`interaction.channels.telegram.mode.${option}`)}</option>
              ))}
            </select>
          </label>
        ) : null}
        {mode === 'own' ? (
          <label className="ix-field">
            <span><IxLabel id="interaction.channels.telegram.token" />{view.tokenSet ? null : ' *'}</span>
            <input type="password" autoComplete="off" value={token} required={!view.tokenSet} disabled={saving || channel.adminDisabled} placeholder={ixLabel(view.tokenSet ? 'interaction.channels.telegram.tokenKeep' : 'interaction.channels.telegram.tokenPlaceholder')} onChange={(event) => setToken(event.target.value)} />
          </label>
        ) : null}
        <button type="submit" className="ix-action ix-action--primary" disabled={saving || channel.adminDisabled}>
          <IxLabel id={saving ? 'interaction.channels.saving' : 'interaction.channels.save'} />
        </button>
      </form>
      {view.botUsername ? <p className="ix-muted"><IxLabel id="interaction.channels.telegram.bot" params={{ bot: `@${view.botUsername}` }} /></p> : null}
      {channel.configured && !channel.adminDisabled ? (
        <div className="ix-row">
          <button type="button" className="ix-action ix-action--neutral" onClick={() => void askCode()}>
            <IxLabel id="interaction.channels.telegram.link" />
          </button>
          {link ? (
            <a className="ix-link-button" href={link.deepLink} target="_blank" rel="noopener noreferrer">
              <IxLabel id="interaction.channels.telegram.openBot" params={{ time: new Date(link.expiresAt).toLocaleTimeString() }} />
            </a>
          ) : null}
        </div>
      ) : null}
      {view.links?.length ? (
        <ul className="ix-list">
          {view.links.map((account) => (
            <li key={account.id} className="ix-item">
              <span>{account.label ?? ixLabel('interaction.channels.telegram.account')}</span>
              {account.source !== 'code' ? <span className="ix-muted"><IxLabel id="interaction.channels.telegram.notProven" /></span> : null}
              <button type="button" className="ix-link-button ix-link-button--danger" onClick={() => void api.unlinkTelegram(account.id).catch(() => undefined)}>
                <IxLabel id="interaction.channels.telegram.unlink" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {message ? <p className="ix-muted" role="status"><IxLabel id={message} /></p> : null}
    </ChannelCardFrame>
  );
}
