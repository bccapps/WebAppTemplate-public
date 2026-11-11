/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useState } from 'react';
import { useInteractionInbox, useInteractionPrefs } from '../hooks/interactionHooks';
import { useBrowserNotificationPermission } from '../hooks/interactionHooks';
import { shouldPromptForPermission } from '../pure/inappDisplay';
import { ixLabel } from '../services/labels';
import { IxLabel, IxText } from './IxText';
import { InteractionQuestionModal } from './InteractionQuestionModal';
import '../styles/tokens.css';
import '../styles/interaction.css';

/** Open questions + unread notices, for the app's header (04 §10.2). `onOpen`: where a click leads (the inbox page). */
export function InteractionInboxBadge({ onOpen }: { onOpen?: () => void }) {
  const { unread } = useInteractionInbox();
  return (
    <button type="button" className="ix-badge-button" onClick={onOpen} aria-label={ixLabel('interaction.inbox.badge', { count: unread })} title={ixLabel('interaction.inbox.badge', { count: unread })}>
      <span aria-hidden="true">🔔</span>
      {unread > 0 ? <span className="ix-badge">{unread > 99 ? '99+' : unread}</span> : null}
    </button>
  );
}

/** Pending questions first, then the unread notices; « mark all read ». */
export function InteractionInboxPanel() {
  const { tickets, notices, loading, markRead } = useInteractionInbox();
  const [open, setOpen] = useState<string | null>(null);
  if (loading) return <p className="ix-muted"><IxLabel id="interaction.inbox.loading" /></p>;
  return (
    <section className="ix-panel" aria-labelledby="ix-inbox-title">
      <div className="ix-panel-header">
        <h3 id="ix-inbox-title"><IxLabel id="interaction.inbox.title" /></h3>
        {notices.length > 0 ? (
          <button type="button" className="ix-link-button" onClick={() => void markRead('all')}>
            <IxLabel id="interaction.inbox.markAllRead" />
          </button>
        ) : null}
      </div>
      {tickets.length === 0 && notices.length === 0 ? <p className="ix-muted"><IxLabel id="interaction.inbox.empty" /></p> : null}
      {tickets.length > 0 ? (
        <>
          <h4><IxLabel id="interaction.inbox.questions" /></h4>
          <ul className="ix-list">
            {tickets.map((ticket) => (
              <li key={ticket.id} className="ix-item ix-item--unread">
                <button type="button" className="ix-item-button" onClick={() => setOpen(ticket.id)}>
                  <span className={`ix-category ix-category--${ticket.category}`}><IxLabel id={`interaction.categories.${ticket.category}`} /></span>
                  <IxText text={ticket.summary.title} />
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {notices.length > 0 ? (
        <>
          <h4><IxLabel id="interaction.inbox.notices" /></h4>
          <ul className="ix-list">
            {notices.map((notice) => (
              <li key={notice.id} className={notice.readAt ? 'ix-item' : 'ix-item ix-item--unread'}>
                <div className="ix-item-main">
                  <span className={`ix-category ix-category--${notice.category}`}><IxLabel id={`interaction.categories.${notice.category}`} /></span>
                  <strong><IxText text={notice.title} /></strong>
                  {notice.body ? <span className="ix-muted"><IxText text={notice.body} /></span> : null}
                  <time className="ix-muted" dateTime={notice.createdAt}>{new Date(notice.createdAt).toLocaleString()}</time>
                </div>
                <button type="button" className="ix-link-button" onClick={() => void markRead([notice.id])}>
                  <IxLabel id="interaction.inbox.markRead" />
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {open ? <InteractionQuestionModal ticketId={open} onClose={() => setOpen(null)} /> : null}
    </section>
  );
}

/**
 * « Enable browser notifications » (04 §10.2): only when the wanted display is `browser`, the browser can still ask and
 * this browser's user did not dismiss it. The permission is asked from the button click only.
 */
export function BrowserNotificationPrompt() {
  const { prefs } = useInteractionPrefs();
  const { permission, request, dismissed, dismiss } = useBrowserNotificationPermission();
  if (!prefs || !shouldPromptForPermission(prefs.effectiveInappDisplay, permission, dismissed)) return null;
  return (
    <div className="ix-prompt" role="region" aria-label={ixLabel('interaction.prompt.title')}>
      <span><IxLabel id="interaction.prompt.text" /></span>
      <button type="button" className="ix-action ix-action--primary" onClick={() => void request()}>
        <IxLabel id="interaction.prompt.enable" />
      </button>
      <button type="button" className="ix-link-button" onClick={dismiss}>
        <IxLabel id="interaction.prompt.dismiss" />
      </button>
    </div>
  );
}
