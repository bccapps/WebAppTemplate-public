/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// The delivery plan of one notice for one user (04 §7 steps 3-5), pure: which external channels are used, which are
// skipped and why. `inapp` is not part of it: it is always delivered (invariant 1).

import type { InteractionCategory, InteractionPriority } from '../types/interactionTypes';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Built-in order after the user's `position` (04 §7.3); other kinds alphabetically after these. */
const BUILT_IN_ORDER = ['browser', 'telegram', 'email', 'webhook'];

export interface PlanChannel {
  kind: string;
  enabled: boolean;
  adminDisabled: boolean;
  position: number;
  ready: boolean;
  /** Why it is not ready (`NOT_CONFIGURED`, `NOT_LINKED`, `NO_SUBSCRIPTION`…). */
  notReadyCode: string | null;
}

export interface PlanPrefs {
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  timezone: string;
  criticalBypass: boolean;
  routing: Partial<Record<InteractionCategory, string[] | null>> | null;
}

export interface PlanInput {
  category: InteractionCategory;
  priority: InteractionPriority;
  /** `interaction_enabledKinds` intersected with the registered providers. */
  enabledKinds: readonly string[];
  channels: readonly PlanChannel[];
  prefs: PlanPrefs;
  now: Date;
  /** Kinds left out on purpose (the « new Telegram link » notice goes to the OTHER channels). */
  excludeKinds?: readonly string[];
}

export interface PlanEntry {
  kind: string;
  send: boolean;
  /** Skip reason (04 §12.3) when `send` is false. */
  code: string | null;
}

/** True when `now` falls in the quiet window, in `timeZone` (a night window such as 22:00-07:00 is allowed). */
export function withinQuietHours(window: { start: string | null; end: string | null; timeZone: string }, now: Date): boolean {
  if (!window.start || !window.end || !HHMM.test(window.start) || !HHMM.test(window.end)) return false;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', { timeZone: window.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  } catch {
    return false;
  }
  const minutes = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') * 60 + Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const toMinutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  const start = toMinutes(window.start);
  const end = toMinutes(window.end);
  if (start === end) return false;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/** Quiet hours hold back `info` only, and not a `critical` one when the user lets critical notices through (invariant 7). */
export function quietHoursHoldBack(prefs: PlanPrefs, category: InteractionCategory, priority: InteractionPriority, now: Date): boolean {
  if (category !== 'info') return false;
  if (priority === 'critical' && prefs.criticalBypass) return false;
  return withinQuietHours({ start: prefs.quietHoursStart, end: prefs.quietHoursEnd, timeZone: prefs.timezone }, now);
}

/** Order of the channels: `position`, then browser, telegram, email, webhook, then the others alphabetically. */
export function compareChannels(a: Pick<PlanChannel, 'kind' | 'position'>, b: Pick<PlanChannel, 'kind' | 'position'>): number {
  if (a.position !== b.position) return a.position - b.position;
  const rank = (kind: string): number => {
    const index = BUILT_IN_ORDER.indexOf(kind);
    return index === -1 ? BUILT_IN_ORDER.length : index;
  };
  return rank(a.kind) - rank(b.kind) || a.kind.localeCompare(b.kind);
}

function availability(channel: PlanChannel, enabledKinds: readonly string[], excluded: readonly string[]): string | null {
  if (excluded.includes(channel.kind)) return 'ROUTED_OFF';
  if (!enabledKinds.includes(channel.kind)) return 'KIND_DISABLED';
  if (channel.adminDisabled) return 'ADMIN_DISABLED';
  if (!channel.enabled) return 'DISABLED';
  if (!channel.ready) return channel.notReadyCode ?? 'NOT_CONFIGURED';
  return null;
}

/**
 * Steps 3-5 of 04 §7: every configured channel gets an entry (skipped ones with their code). Routing keeps the kinds of
 * `routing[category]` (null = all). `approval` / `security` are never silent: when routing keeps no ready channel but
 * the user has some, all the ready ones are used. Quiet hours then skip the external channels of an `info` notice.
 */
export function planDelivery(input: PlanInput): PlanEntry[] {
  const excluded = input.excludeKinds ?? [];
  const channels = [...input.channels].sort(compareChannels);
  const route = input.prefs.routing?.[input.category] ?? null;
  const entries: PlanEntry[] = channels.map((channel) => {
    const code = availability(channel, input.enabledKinds, excluded);
    if (code) return { kind: channel.kind, send: false, code };
    if (route !== null && !route.includes(channel.kind)) return { kind: channel.kind, send: false, code: 'ROUTED_OFF' };
    return { kind: channel.kind, send: true, code: null };
  });
  const mustReach = input.category === 'approval' || input.category === 'security';
  if (mustReach && !entries.some((entry) => entry.send)) {
    for (const entry of entries) if (entry.code === 'ROUTED_OFF' && !excluded.includes(entry.kind)) Object.assign(entry, { send: true, code: null });
  }
  if (quietHoursHoldBack(input.prefs, input.category, input.priority, input.now)) {
    for (const entry of entries) if (entry.send) Object.assign(entry, { send: false, code: 'QUIET_HOURS' });
  }
  return entries;
}
