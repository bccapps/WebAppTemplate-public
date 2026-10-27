/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { ConfigurationService } from '../../common/services/ConfigurationService';
import { EmailLayoutService, escapeHtml } from '../../common/services/EmailLayoutService';
import { EmailService } from '../../common/services/EmailService';
import { LocaleService } from '../../common/services/LocaleService';
import { USER_CONTACT, type UserContactProvider } from '../../common/types/ExtensionPoints';
import { IssueReportEntity } from '../entities/IssueReportEntity';
import { ISSUE_REPORT_CLOSED_REASONS, ISSUE_REPORT_NOTIFY_BATCH, type IssueReportClosedReason } from '../issueReportTypes';

export type NotifyOutcome = 'sent' | 'no_address' | 'taken' | 'failed';

export interface ClosureMessage {
  subject: string;
  html: string;
  text: string;
}

/** Attempts per report and per process before the notice is given up (the claim is then kept). */
export const NOTIFY_MAX_ATTEMPTS = 3;

/** First two letters of a locale code (`fr-FR` → `fr`), `null` when it is not one. */
export function languageOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^([a-z]{2})(?:[-_]|$)/i.exec(value.trim());
  return match ? match[1].toLowerCase() : null;
}

/**
 * Closure notice of a report, sent once to its reporter through `EmailService` (address and language from the
 * `USER_CONTACT` provider of the `user` module). The address is never stored nor logged by this module.
 */
@Injectable()
export class IssueReportNotificationService {
  private readonly logger = new Logger(IssueReportNotificationService.name);
  private readonly warned = new Set<string>();
  private readonly attempts = new Map<string, number>();

  constructor(
    @InjectRepository(IssueReportEntity)
    private readonly repo: Repository<IssueReportEntity>,
    private readonly emailService: EmailService,
    private readonly emailLayout: EmailLayoutService,
    private readonly localeService: LocaleService,
    private readonly configurationService: ConfigurationService,
    @Optional() @Inject(USER_CONTACT) private readonly contact?: UserContactProvider | null,
  ) {}

  /** Sends the pending closure notices (closed, not yet notified), oldest closure first; returns how many went out. */
  async notifyPending(): Promise<number> {
    const pending = await this.repo.find({
      where: { status: 'closed', notifiedAt: IsNull() },
      order: { closedAt: 'ASC' },
      take: ISSUE_REPORT_NOTIFY_BATCH,
    });
    if (pending.length === 0) return 0;
    if (!this.contact) {
      this.warnOnce('no-contact', 'No USER_CONTACT provider (module "user"): closure e-mails of issue reports are not sent');
      return 0;
    }
    if (this.emailService.getProvider() === 'none') {
      this.warnOnce('no-email', 'E-mail provider is "none": closure e-mails of issue reports wait until one is configured');
      return 0;
    }
    let sent = 0;
    for (const report of pending) {
      if ((await this.notify(report)) === 'sent') sent += 1;
    }
    return sent;
  }

  /**
   * One report: claims it (`notifiedAt` set only if still empty, so two runs never both send), then sends. A failed
   * send releases the claim for a later run, up to `NOTIFY_MAX_ATTEMPTS`; no address keeps the claim (nothing to send).
   */
  async notify(report: IssueReportEntity): Promise<NotifyOutcome> {
    const contact = this.contact;
    if (!contact) return 'failed';
    const claim = await this.repo.update({ id: report.id, notifiedAt: IsNull() }, { notifiedAt: new Date() });
    if (!claim.affected) return 'taken';
    try {
      const address = await contact.emailOf(report.userId);
      if (!address) return 'no_address';
      const message = await this.compose(report, await this.languagesFor(contact, report.userId));
      const result = await this.emailService.sendEmail(address, message.subject, message.html, { text: message.text });
      if (result.success) {
        this.attempts.delete(report.id);
        return 'sent';
      }
    } catch (error) {
      this.logger.warn(`Closure e-mail of issue #${report.hubNumber} could not be prepared: ${(error as Error).message}`);
    }
    return this.release(report);
  }

  /** Subject, HTML (brand shell, escaped text) and plain-text versions, in the first language that has the keys. */
  async compose(report: IssueReportEntity, languages: string[]): Promise<ClosureMessage> {
    const reason: IssueReportClosedReason = (ISSUE_REPORT_CLOSED_REASONS as readonly string[]).includes(report.closedReason ?? '')
      ? (report.closedReason as IssueReportClosedReason)
      : 'manual';
    const params = [report.hubNumber, report.title];
    const [subject, greeting, body, thanks] = await Promise.all([
      this.translate(`issueReport.email.${reason}.subject`, languages, params),
      this.translate('issueReport.email.greeting', languages, params),
      this.translate(`issueReport.email.${reason}.body`, languages, params),
      this.translate('issueReport.email.thanks', languages, params),
    ]);
    const bodyHtml = [greeting, body, thanks].map((line) => `<p style="margin:0 0 16px 0;">${escapeHtml(line)}</p>`).join('\n');
    return {
      subject,
      html: this.emailLayout.wrap(bodyHtml, { preheader: subject }),
      text: [greeting, body, thanks].join('\n\n'),
    };
  }

  /** The reporter's language, then the app default (`localeDefault`), then English. */
  private async languagesFor(contact: UserContactProvider, userId: string): Promise<string[]> {
    const preferred = contact.localeOf ? languageOf(await contact.localeOf(userId).catch(() => null)) : null;
    const fallback = languageOf(this.configurationService.get('localeDefault'));
    return [...new Set([preferred, fallback, 'en'].filter((lang): lang is string => lang !== null))];
  }

  /** `LocaleService.translate` returns the key itself when a language lacks it: try the next language then. */
  private async translate(key: string, languages: string[], params: (string | number)[]): Promise<string> {
    for (const lang of languages) {
      const text = await this.localeService.translate(key, lang, params);
      if (text !== key) return text;
    }
    return key;
  }

  private async release(report: IssueReportEntity): Promise<NotifyOutcome> {
    const attempt = (this.attempts.get(report.id) ?? 0) + 1;
    this.attempts.set(report.id, attempt);
    if (attempt < NOTIFY_MAX_ATTEMPTS) {
      await this.repo.update({ id: report.id }, { notifiedAt: null });
      this.logger.warn(`Closure e-mail of issue #${report.hubNumber} failed (attempt ${attempt}/${NOTIFY_MAX_ATTEMPTS}), retried on the next run`);
    } else {
      this.attempts.delete(report.id);
      this.logger.warn(`Closure e-mail of issue #${report.hubNumber} failed ${attempt} times, given up`);
    }
    return 'failed';
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.logger.warn(message);
  }
}
