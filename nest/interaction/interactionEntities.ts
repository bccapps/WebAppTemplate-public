/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { InteractionDeliveryEntity } from './entities/InteractionDeliveryEntity';
import { InteractionLinkCodeEntity } from './entities/InteractionLinkCodeEntity';
import { InteractionNoticeEntity } from './entities/InteractionNoticeEntity';
import { InteractionSecretEntity } from './entities/InteractionSecretEntity';
import { InteractionSendCounterEntity } from './entities/InteractionSendCounterEntity';
import { InteractionTelegramBotEntity } from './entities/InteractionTelegramBotEntity';
import { InteractionTelegramLinkEntity } from './entities/InteractionTelegramLinkEntity';
import { InteractionTelegramUpdateEntity } from './entities/InteractionTelegramUpdateEntity';
import { InteractionTicketCardEntity } from './entities/InteractionTicketCardEntity';
import { InteractionTicketEntity } from './entities/InteractionTicketEntity';
import { InteractionTicketRecipientEntity } from './entities/InteractionTicketRecipientEntity';
import { InteractionUserChannelEntity } from './entities/InteractionUserChannelEntity';
import { InteractionUserPrefEntity } from './entities/InteractionUserPrefEntity';
import { InteractionWebPushSubscriptionEntity } from './entities/InteractionWebPushSubscriptionEntity';

/** The 14 tables `interaction_*` (04 §6, plus the webhook's seen updates). Flat in `entities/`: the routed mode of `database` does not read sub-folders. */
export const INTERACTION_ENTITIES = [
  InteractionUserChannelEntity,
  InteractionUserPrefEntity,
  InteractionWebPushSubscriptionEntity,
  InteractionNoticeEntity,
  InteractionDeliveryEntity,
  InteractionTicketEntity,
  InteractionTicketRecipientEntity,
  InteractionTicketCardEntity,
  InteractionTelegramLinkEntity,
  InteractionLinkCodeEntity,
  InteractionTelegramBotEntity,
  InteractionSendCounterEntity,
  InteractionSecretEntity,
  InteractionTelegramUpdateEntity,
];
