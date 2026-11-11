/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useInRouterContext, useNavigate } from 'react-router-dom';
import { sessionAuth } from '../../common/auth/sessionAuth';
import { i18n } from '../../common/core/i18n/I18n';
import { toastService } from '../../common/core/toast/ToastService';
import { useSessionKeys } from '../../common/hooks/useSessionKeys';
import { browserSurface } from '../browser/browserNotifications';
import { showNotice } from '../browser/showNotice';
import { useWebPushSessionGuard } from '../browser/webPushSession';
import { useInboxStream } from '../hooks/interactionHooks';
import { createInboxHost } from '../pure/hostRouter';
import type { Navigate } from '../pure/navigation';
import { interactionApi } from '../services/interactionApi';
import { InteractionQuestionModal } from './InteractionQuestionModal';

/** Outside a router (an app that mounts the host above it): a full page load. */
const assignLocation: Navigate = (path) => window.location.assign(path);

/**
 * Mounted once by the app (next to `<ToastZone />`, or by the plugin's provider). For a signed-in USER only: follows
 * `interaction.inbox` — a notice is read and shown (toast or native notification), a question opens its modal when
 * the tab is visible and no modal is open (otherwise the badge counts it), a closed question shows its outcome in the
 * modal, and a resync (stream reconnected) re-reads the inbox. `?interaction=inbox` in the URL (the link of an
 * external channel) opens the oldest open question. A notice's link goes through the app router when there is one.
 * When the signed-in user changes away (logout, session end), this browser's Web Push subscription is dropped.
 */
export function InteractionHost() {
  useSessionKeys(['user']);
  const inRouter = useInRouterContext();
  const user = sessionAuth.mode === 'users' && sessionAuth.isAuth() ? sessionAuth.get() : null;
  // This browser's Web Push subscription leaves with the user who had it (logout, session end, another account).
  useWebPushSessionGuard(user ? user.id : null);
  if (!user) return null;
  return inRouter ? <RoutedHost key={String(user.id)} /> : <HostForUser key={String(user.id)} navigate={assignLocation} />;
}

function RoutedHost() {
  const navigate = useNavigate();
  return <HostForUser navigate={navigate} />;
}

function HostForUser({ navigate }: { navigate: Navigate }) {
  const [ticketId, setTicketId] = useState<string | null>(null);
  const openRef = useRef<string | null>(null);
  openRef.current = ticketId;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  const host = useMemo(
    () =>
      createInboxHost({
        inbox: () => interactionApi.inbox(),
        notice: (id) => interactionApi.notice(id),
        effectiveDisplay: () => interactionApi.prefs().then((prefs) => prefs.effectiveInappDisplay),
        isVisible: () => typeof document !== 'undefined' && document.visibilityState === 'visible',
        currentTicketId: () => openRef.current,
        openTicket: (id) => {
          openRef.current = id;
          setTicketId(id);
        },
        showNotice: (notice, wanted) =>
          showNotice(notice, wanted, {
            translate: (key) => i18n.get(key),
            toast: (input) => toastService.notice(input),
            navigate: (path) => navigateRef.current(path),
            surface: browserSurface,
          }),
      }),
    [],
  );

  useEffect(() => {
    const explicit = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('interaction') === 'inbox';
    void host.start(explicit);
  }, [host]);

  useInboxStream(host.onEvent, () => void host.resync());

  const close = () => {
    if (ticketId) host.dismissed(ticketId);
    setTicketId(null);
  };
  return ticketId ? <InteractionQuestionModal ticketId={ticketId} onClose={close} /> : null;
}
