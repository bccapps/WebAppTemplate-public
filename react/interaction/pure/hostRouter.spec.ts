/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { describe, expect, it, vi } from 'vitest';
import { createInboxHost, oldestOpenTicketId, type InboxHostDeps } from './hostRouter';
import type { InteractionNoticeDto } from '../types/interactionTypes';

const ticket = (id: string, createdAt: string, status = 'open') => ({ id, status, createdAt });
const notice = (patch: Partial<InteractionNoticeDto> = {}): InteractionNoticeDto =>
  ({ id: 'n1', type: 't', source: 's', category: 'info', priority: 'normal', title: { raw: 'T' }, body: null, url: null, data: null, ticketId: null, createdAt: '', readAt: null, ...patch }) as InteractionNoticeDto;

function setup(overrides: Partial<InboxHostDeps> = {}) {
  const state = { tickets: [] as Array<{ id: string; status: string; createdAt: string }>, visible: true, current: null as string | null };
  const opened: string[] = [];
  const shown: Array<[string, string]> = [];
  const deps: InboxHostDeps = {
    inbox: async () => ({ tickets: state.tickets }) as never,
    notice: async () => notice(),
    effectiveDisplay: async () => 'browser',
    isVisible: () => state.visible,
    currentTicketId: () => state.current,
    openTicket: (id) => {
      opened.push(id);
      state.current = id;
    },
    showNotice: async (n, wanted) => void shown.push([n.id, wanted]),
    ...overrides,
  };
  return { host: createInboxHost(deps), state, opened, shown };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('oldestOpenTicketId', () => {
  it('takes the oldest open question, ignoring answered ones and exclusions', () => {
    const tickets = [ticket('b', '2026-01-02'), ticket('a', '2026-01-01', 'answered'), ticket('c', '2026-01-03')];
    expect(oldestOpenTicketId(tickets)).toBe('b');
    expect(oldestOpenTicketId(tickets, new Set(['b']))).toBe('c');
    expect(oldestOpenTicketId([])).toBeNull();
  });
});

describe('InboxHost events', () => {
  it('ticket.opened opens the modal only when the tab is visible and no modal is open', () => {
    const { host, state, opened } = setup();
    state.visible = false;
    host.onEvent({ type: 'ticket.opened', id: 't1' });
    expect(opened).toEqual([]);
    state.visible = true;
    host.onEvent({ type: 'ticket.opened', id: 't1' });
    host.onEvent({ type: 'ticket.opened', id: 't2' });
    expect(opened).toEqual(['t1']);
  });

  it('ticket.closed and unknown events change nothing (the modal follows its ticket)', () => {
    const { host, opened, shown } = setup();
    host.onEvent({ type: 'ticket.closed', id: 't1' });
    host.onEvent({ type: 'whatever' });
    expect(opened).toEqual([]);
    expect(shown).toEqual([]);
  });

  it('a notice is read and shown with the wanted display, except one carried by a question', async () => {
    const { host, shown } = setup({ notice: async (id) => notice({ id, ticketId: id === 'n2' ? 't9' : null }) });
    await host.start(false);
    host.onEvent({ type: 'notice', id: 'n1' });
    host.onEvent({ type: 'notice', id: 'n2' });
    await flush();
    expect(shown).toEqual([['n1', 'browser']]);
  });

  it('a notice that cannot be read is dropped silently', async () => {
    const { host, shown } = setup({ notice: async () => Promise.reject(new Error('down')) });
    host.onEvent({ type: 'notice', id: 'n1' });
    await flush();
    expect(shown).toEqual([]);
  });

  it('channels.changed reloads the display preference', async () => {
    let display: 'toast' | 'browser' = 'toast';
    const { host, shown } = setup({ effectiveDisplay: async () => display });
    display = 'browser';
    host.onEvent({ type: 'channels.changed' });
    await flush();
    host.onEvent({ type: 'notice', id: 'n1' });
    await flush();
    expect(shown).toEqual([['n1', 'browser']]);
  });
});

describe('InboxHost start and resync', () => {
  it('start does not open pending questions, unless the URL asked for the inbox (oldest first)', async () => {
    const a = setup();
    a.state.tickets = [ticket('b', '2026-01-02'), ticket('a', '2026-01-01')];
    await a.host.start(false);
    expect(a.opened).toEqual([]);
    const b = setup();
    b.state.tickets = [ticket('b', '2026-01-02'), ticket('a', '2026-01-01')];
    await b.host.start(true);
    expect(b.opened).toEqual(['a']);
  });

  it('resync opens a question missed while the stream was down, once', async () => {
    const { host, state, opened } = setup();
    state.tickets = [ticket('old', '2026-01-01')];
    await host.start(false);
    state.tickets = [ticket('old', '2026-01-01'), ticket('missed', '2026-01-02')];
    await host.resync();
    expect(opened).toEqual(['missed']);
    host.dismissed('missed');
    state.current = null;
    await host.resync();
    expect(opened).toEqual(['missed']);
  });

  it('resync respects an open modal and a hidden tab', async () => {
    const { host, state, opened } = setup();
    state.tickets = [ticket('t1', '2026-01-01')];
    state.current = 'other';
    await host.resync();
    state.current = null;
    state.visible = false;
    await host.resync();
    expect(opened).toEqual([]);
    state.visible = true;
    await host.resync();
    expect(opened).toEqual(['t1']);
  });

  it('resync reloads the display and survives a failing inbox read', async () => {
    const effectiveDisplay = vi.fn(async () => 'toast' as const);
    const { host, opened } = setup({ inbox: async () => Promise.reject(new Error('down')), effectiveDisplay });
    await host.resync();
    expect(effectiveDisplay).toHaveBeenCalledOnce();
    expect(opened).toEqual([]);
  });
});
