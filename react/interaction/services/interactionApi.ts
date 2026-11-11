/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { HttpResult } from '../../common/core/http/HttpResult';
import { httpService } from '../../common/core/http/HttpService';
import { configurationService } from '../../common/services/ConfigurationService';
import {
  INTERACTION_ERROR_CODES,
  type ChannelTestResultDto,
  type InboxDto,
  type InteractionApiError,
  type InteractionChannelAdminDto,
  type InteractionChannelDto,
  type InteractionChannelSaveDto,
  type InteractionErrorCode,
  type InteractionNoticeDto,
  type InteractionPrefBody,
  type InteractionPrefDto,
  type InteractionTicketDto,
  type TelegramLinkCodeDto,
  type WebPushSubscribeBody,
} from '../types/interactionTypes';

function me(path: string): string {
  return `${configurationService.getApiUrl('interaction')}/interaction/me${path}`;
}

function admin(path: string): string {
  return `${configurationService.getApiUrl('interaction')}/admin/interaction${path}`;
}

/** An HTTP failure as `{ code, status, details }` (the code of 04 §12, `UNKNOWN` otherwise). */
export function toApiError(payload: unknown): InteractionApiError {
  const body = (payload ?? {}) as { code?: unknown; statusCode?: unknown; raw?: { details?: unknown } };
  const code = (INTERACTION_ERROR_CODES as readonly string[]).includes(String(body.code)) ? (body.code as InteractionErrorCode) : 'UNKNOWN';
  const details = body.raw && typeof body.raw.details === 'object' && body.raw.details !== null ? (body.raw.details as Record<string, unknown>) : null;
  return { code, status: typeof body.statusCode === 'number' ? body.statusCode : 0, details };
}

function promiseOf<T>(result: HttpResult): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const fail = (payload: unknown) => reject(toApiError(payload));
    result.then(resolve).fail(fail).error(fail).notAuthorized(fail);
  });
}

/** Every call of `nest/interaction` (04 §11). URLs: `getApiUrl('interaction')` + the resource path. */
export const interactionApi = {
  channels: (): Promise<InteractionChannelDto[]> => promiseOf(httpService.get(me('/channels'))),
  configure: (kind: string, body: Record<string, unknown>): Promise<InteractionChannelSaveDto> => promiseOf(httpService.put(me(`/channels/${encodeURIComponent(kind)}`), body)),
  setState: (kind: string, body: { enabled?: boolean; position?: number }): Promise<InteractionChannelDto> => promiseOf(httpService.patch(me(`/channels/${encodeURIComponent(kind)}`), body)),
  remove: (kind: string): Promise<{ success: true }> => promiseOf(httpService.delete(me(`/channels/${encodeURIComponent(kind)}`))),
  verify: (kind: string, code: string): Promise<InteractionChannelDto> => promiseOf(httpService.post(me(`/channels/${encodeURIComponent(kind)}/verify`), { code })),
  test: (kind: string): Promise<ChannelTestResultDto> => promiseOf(httpService.post(me(`/channels/${encodeURIComponent(kind)}/test`), {})),
  rotateWebhookSecret: (): Promise<InteractionChannelSaveDto> => promiseOf(httpService.post(me('/channels/webhook/secret'), {})),
  telegramLinkCode: (): Promise<TelegramLinkCodeDto> => promiseOf(httpService.post(me('/channels/telegram/link-code'), {})),
  unlinkTelegram: (linkId: string): Promise<InteractionChannelDto> => promiseOf(httpService.delete(me(`/channels/telegram/links/${encodeURIComponent(linkId)}`))),
  webPushPublicKey: (): Promise<{ publicKey: string }> => promiseOf(httpService.get(me('/webpush/public-key'))),
  subscribeWebPush: (body: WebPushSubscribeBody): Promise<{ success: true }> => promiseOf(httpService.post(me('/webpush/subscriptions'), body)),
  /** `POST …/subscriptions/remove`: the endpoint travels in the body (never in a URL). */
  unsubscribeWebPush: (endpoint: string): Promise<{ success: true }> => promiseOf(httpService.post(me('/webpush/subscriptions/remove'), { endpoint })),
  prefs: (): Promise<InteractionPrefDto> => promiseOf(httpService.get(me('/prefs'))),
  savePrefs: (body: InteractionPrefBody): Promise<InteractionPrefDto> => promiseOf(httpService.put(me('/prefs'), body)),
  inbox: (): Promise<InboxDto> => promiseOf(httpService.get(me('/inbox'))),
  notice: (id: string): Promise<InteractionNoticeDto> => promiseOf(httpService.get(me(`/notices/${encodeURIComponent(id)}`))),
  markRead: (ids: string[] | 'all'): Promise<{ success: true }> => promiseOf(httpService.post(me('/notices/read'), ids === 'all' ? { all: true } : { ids })),
  ticket: (id: string): Promise<InteractionTicketDto> => promiseOf(httpService.get(me(`/tickets/${encodeURIComponent(id)}`))),
  answer: (id: string, actionId: string, stepUpProof?: string): Promise<InteractionTicketDto> =>
    promiseOf(httpService.post(me(`/tickets/${encodeURIComponent(id)}/answer`), stepUpProof ? { actionId, stepUpProof } : { actionId })),
  adminChannels: (filter: { userId?: number; kind?: string } = {}): Promise<InteractionChannelAdminDto[]> => {
    const query = new URLSearchParams();
    if (filter.userId) query.set('userId', String(filter.userId));
    if (filter.kind) query.set('kind', filter.kind);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return promiseOf(httpService.get(admin(`/channels${suffix}`)));
  },
  adminSetDisabled: (userId: number, kind: string, adminDisabled: boolean): Promise<{ success: true }> =>
    promiseOf(httpService.patch(admin(`/users/${userId}/channels/${encodeURIComponent(kind)}`), { adminDisabled })),
};
