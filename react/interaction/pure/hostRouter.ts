/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
// The decisions of `<InteractionHost />` (04 §10.2), without React: which inbox event shows a notice, opens the
// question modal or only re-reads the inbox. Every dependency is injected, so the rules are tested without a DOM.

import type { InappDisplay, InboxDto, InteractionNoticeDto } from '../types/interactionTypes';

export interface HostEvent {
  type: string;
  id?: string | number;
}

export interface InboxHostDeps {
  inbox(): Promise<Pick<InboxDto, 'tickets'>>;
  notice(id: string): Promise<InteractionNoticeDto>;
  effectiveDisplay(): Promise<InappDisplay>;
  isVisible(): boolean;
  /** The ticket of the modal on screen, null when none. */
  currentTicketId(): string | null;
  openTicket(id: string): void;
  showNotice(notice: InteractionNoticeDto, wanted: InappDisplay): Promise<void>;
}

export interface InboxHost {
  /** First read when the host mounts; `explicit` (`?interaction=inbox`) opens the oldest open question. */
  start(explicit: boolean): Promise<void>;
  /** The stream asked to reload everything, or came back from a failure: re-reads the inbox. */
  resync(): Promise<void>;
  onEvent(event: HostEvent): void;
  /** The user closed the modal of `id`: it is not offered again by a later resync. */
  dismissed(id: string): void;
}

/** The oldest open question of `tickets` not in `exclude`. */
export function oldestOpenTicketId(tickets: ReadonlyArray<{ id: string; status: string; createdAt: string }>, exclude: ReadonlySet<string> = new Set()): string | null {
  const open = tickets.filter((ticket) => ticket.status === 'open' && !exclude.has(ticket.id));
  open.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return open[0]?.id ?? null;
}

export function createInboxHost(deps: InboxHostDeps): InboxHost {
  let display: InappDisplay = 'toast';
  /** Questions already known to this tab (shown, closed by the user or present at mount): a resync offers only the others. */
  const seen = new Set<string>();

  const loadDisplay = () =>
    deps.effectiveDisplay().then(
      (value) => {
        display = value;
      },
      () => undefined,
    );
  const open = (id: string) => {
    seen.add(id);
    deps.openTicket(id);
  };
  const readInbox = (): Promise<Array<{ id: string; status: string; createdAt: string }>> =>
    deps.inbox().then((inbox) => inbox.tickets, () => []);

  return {
    async start(explicit) {
      void loadDisplay();
      const tickets = await readInbox();
      if (explicit) {
        const oldest = oldestOpenTicketId(tickets);
        if (oldest && !deps.currentTicketId()) open(oldest);
        return;
      }
      for (const ticket of tickets) seen.add(ticket.id);
    },
    async resync() {
      void loadDisplay();
      const tickets = await readInbox();
      if (deps.currentTicketId() || !deps.isVisible()) return;
      const missed = oldestOpenTicketId(tickets, seen);
      if (missed) open(missed);
    },
    onEvent(event) {
      const id = typeof event.id === 'string' ? event.id : null;
      if (event.type === 'notice' && id) {
        void deps.notice(id).then((notice) => (notice.ticketId ? undefined : deps.showNotice(notice, display)), () => undefined);
      } else if (event.type === 'ticket.opened' && id) {
        if (!deps.currentTicketId() && deps.isVisible()) open(id);
      } else if (event.type === 'channels.changed') {
        void loadDisplay();
      }
      // `ticket.closed`: nothing to do here, the modal shown follows its ticket (`useInteractionTicket`) and displays the outcome.
    },
    dismissed(id) {
      seen.add(id);
    },
  };
}
