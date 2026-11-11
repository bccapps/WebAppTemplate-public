/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { InteractionDeliveryAdminDto } from '../dtos/InteractionDeliveryAdminDto';
import type { InteractionNoticeDto } from '../dtos/InteractionNoticeDto';
import type { InteractionTicketAdminDto } from '../dtos/InteractionTicketAdminDto';
import type { InteractionTicketDto } from '../dtos/InteractionTicketDto';
import type { InteractionDeliveryEntity } from '../entities/InteractionDeliveryEntity';
import type { InteractionNoticeEntity } from '../entities/InteractionNoticeEntity';
import type { InteractionTicketEntity } from '../entities/InteractionTicketEntity';
import type { InteractionUserChannelEntity } from '../entities/InteractionUserChannelEntity';
import { stepUpPurposeOf } from '../types/ports';
import type { StoredChannel } from '../types/providerTypes';

export function iso(date: Date | null | undefined): string | null {
  return date ? new Date(date).toISOString() : null;
}

/** Entity → what providers see. */
export function toStoredChannel(row: InteractionUserChannelEntity): StoredChannel {
  return {
    id: row.id,
    userId: row.userId,
    kind: row.kind,
    enabled: row.enabled,
    adminDisabled: row.adminDisabled,
    position: row.position,
    config: { ...(row.config ?? {}) },
    verification: row.verification ? { ...row.verification } : null,
    secretId: row.secretId,
    externalKey: row.externalKey,
    verifiedAt: row.verifiedAt,
  };
}

export function toNoticeDto(row: InteractionNoticeEntity): InteractionNoticeDto {
  return {
    id: row.id,
    type: row.type,
    source: row.source,
    category: row.category,
    priority: row.priority,
    title: row.title,
    body: row.body,
    url: row.url,
    data: row.data,
    ticketId: row.ticketId,
    createdAt: iso(row.createdAt) as string,
    readAt: iso(row.readAt),
  };
}

/** A ticket for one of its recipients (`viewer`). */
export function toTicketDto(row: InteractionTicketEntity, viewer: number): InteractionTicketDto {
  const answerableFrom = row.answerableFrom ?? ['inapp'];
  const allowedHere = answerableFrom.includes('inapp');
  return {
    id: row.id,
    kind: row.kind,
    source: row.source,
    category: row.category,
    summary: row.summary,
    actions: row.actions.map((action) => ({ id: action.id, label: action.label, style: action.style, allowedHere })),
    answerableFrom,
    freshProofRequired: row.freshProof,
    stepUpPurpose: row.freshProof ? stepUpPurposeOf(row.id) : null,
    status: row.status,
    expiresAt: iso(row.expiresAt) as string,
    answeredVia: row.answeredVia,
    answeredAt: iso(row.answeredAt),
    answeredByMe: row.answeredBy !== null && row.answeredBy === viewer,
    createdAt: iso(row.createdAt) as string,
  };
}

export function toTicketAdminDto(row: InteractionTicketEntity, recipients: number): InteractionTicketAdminDto {
  return {
    id: row.id,
    source: row.source,
    kind: row.kind,
    category: row.category,
    status: row.status,
    recipients,
    expiresAt: iso(row.expiresAt) as string,
    answeredVia: row.answeredVia,
    answeredAt: iso(row.answeredAt),
    createdAt: iso(row.createdAt) as string,
  };
}

export function toDeliveryAdminDto(row: InteractionDeliveryEntity): InteractionDeliveryAdminDto {
  return {
    id: row.id,
    userId: row.userId,
    kind: row.kind,
    category: row.category,
    type: row.type,
    status: row.status,
    code: row.code,
    createdAt: iso(row.createdAt) as string,
    sentAt: iso(row.sentAt),
  };
}
