/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Inject, Injectable, Optional } from '@nestjs/common';
import { BrandService } from '../../common/services/BrandService';
import { ConfigurationService } from '../../common/services/ConfigurationService';
import { LocaleService } from '../../common/services/LocaleService';
import { USER_CONTACT, type UserContactProvider } from '../../common/types/ExtensionPoints';
import { renderText } from '../pure/text';
import type { InteractionText } from '../types/interactionTypes';
import { INTERACTION_DIRECTORY, type InteractionDirectory } from '../types/ports';

const LANG = /^[a-z]{2}$/;

/**
 * Renders texts for a recipient (04 §7.1): language = `directory.localeOf` → `USER_CONTACT.localeOf` → `localeDefault`
 * → `en`; a key goes through `LocaleService.translate`, then `{param}`s, masking and cutting. Links are made absolute
 * with the site URL (`BrandService.absoluteUrl`), or null when it is not configured.
 */
@Injectable()
export class InteractionRenderer {
  constructor(
    @Inject(INTERACTION_DIRECTORY) private readonly directory: InteractionDirectory,
    private readonly locales: LocaleService,
    private readonly configuration: ConfigurationService,
    private readonly brand: BrandService,
    @Optional() @Inject(USER_CONTACT) private readonly contact?: UserContactProvider,
  ) {}

  /** `fr`, `en`… (two letters). */
  async localeOf(userId: number): Promise<string> {
    const fromDirectory = this.directory.localeOf ? await this.directory.localeOf(userId).catch(() => null) : null;
    const fromContact = !fromDirectory && this.contact?.localeOf ? await this.contact.localeOf(userId).catch(() => null) : null;
    return normalizeLang(fromDirectory ?? fromContact) ?? this.defaultLocale();
  }

  defaultLocale(): string {
    return normalizeLang(this.configuration.get('localeDefault')) ?? 'en';
  }

  async render(text: InteractionText, lang: string, max: number): Promise<string> {
    return renderText(text, (key) => this.locales.translate(key, lang), max);
  }

  /** A server text of the module (`interaction.server.*`) with `{param}`s. */
  async server(key: string, lang: string, params?: Record<string, string | number>): Promise<string> {
    return this.render({ key, params }, lang, 4000);
  }

  /** An app path made absolute; null without a site URL. */
  absoluteUrl(path: string | null): string | null {
    if (!path) return null;
    const url = this.brand.absoluteUrl(path);
    return /^https?:\/\//.test(url) ? url : null;
  }
}

/** `fr-FR` → `fr`; null when it does not look like a language. */
export function normalizeLang(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const lang = value.trim().slice(0, 2).toLowerCase();
  return LANG.test(lang) ? lang : null;
}
