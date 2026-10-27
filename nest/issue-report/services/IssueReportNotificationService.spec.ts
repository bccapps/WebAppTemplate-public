/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { FindOperator, type Repository } from 'typeorm';
import type { ConfigurationService } from '../../common/services/ConfigurationService';
import type { EmailLayoutService } from '../../common/services/EmailLayoutService';
import type { EmailService, SendEmailResult } from '../../common/services/EmailService';
import type { LocaleService } from '../../common/services/LocaleService';
import type { UserContactProvider } from '../../common/types/ExtensionPoints';
import type { IssueReportEntity } from '../entities/IssueReportEntity';
import en from '../locales/issue-report.en.json';
import fr from '../locales/issue-report.fr.json';
import { IssueReportNotificationService, languageOf, NOTIFY_MAX_ATTEMPTS } from './IssueReportNotificationService';

const DICTIONARIES: Record<string, Record<string, string>> = { en, fr, de: {} };

/** Same contract as `LocaleService.translate`: unknown language → first dictionary, missing key → the key itself. */
const localeService = {
  translate: async (key: string, lang: string, params: (string | number)[] = []) => {
    const dictionary = DICTIONARIES[lang] ?? DICTIONARIES.en;
    const raw = dictionary[key];
    if (typeof raw !== 'string') return key;
    return params.reduce<string>((text, value, index) => text.split(`{${index}}`).join(String(value)), raw);
  },
} as unknown as LocaleService;

const isNullOperator = (value: unknown) => value instanceof FindOperator && value.type === 'isNull';

/** In-memory repository for the calls the service makes (`find` pending, conditional `update`). */
function repoOf(rows: IssueReportEntity[]) {
  const matches = (row: IssueReportEntity, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) =>
      isNullOperator(value) ? row[key as keyof IssueReportEntity] === null : row[key as keyof IssueReportEntity] === value,
    );
  return {
    find: async ({ where }: { where: Record<string, unknown> }) => rows.filter((row) => matches(row, where)),
    update: async (where: Record<string, unknown>, patch: Partial<IssueReportEntity>) => {
      const hit = rows.filter((row) => matches(row, where));
      hit.forEach((row) => Object.assign(row, patch));
      return { affected: hit.length };
    },
  } as unknown as Repository<IssueReportEntity>;
}

function report(overrides: Partial<IssueReportEntity> = {}): IssueReportEntity {
  return {
    id: 'r1',
    userId: '7',
    hubNumber: 12,
    title: 'Save <b>fails</b>',
    status: 'closed',
    closedReason: 'fixed',
    closedAt: new Date('2026-10-27T09:00:00.000Z'),
    notifiedAt: null,
    createdAt: new Date('2026-10-26T09:00:00.000Z'),
    ...overrides,
  };
}

interface Setup {
  rows?: IssueReportEntity[];
  contact?: UserContactProvider | null;
  provider?: string;
  sendResults?: SendEmailResult[];
}

function setup({ rows = [report()], contact, provider = 'smtp', sendResults = [{ success: true }] }: Setup = {}) {
  const mails: Array<{ to: string; subject: string; html: string; text?: string }> = [];
  let call = 0;
  const emailService = {
    getProvider: () => provider,
    sendEmail: async (to: string, subject: string, html: string, options?: { text?: string }) => {
      mails.push({ to, subject, html, text: options?.text });
      const result = sendResults[Math.min(call, sendResults.length - 1)];
      call += 1;
      return result;
    },
  } as unknown as EmailService;
  const emailLayout = { wrap: (html: string) => `<shell>${html}</shell>` } as unknown as EmailLayoutService;
  const configuration = { get: (key: string) => (key === 'localeDefault' ? 'fr' : undefined) } as unknown as ConfigurationService;
  const resolvedContact =
    contact === undefined ? { emailOf: async () => 'ada@example.com', localeOf: async () => 'fr-FR' } : contact;
  const service = new IssueReportNotificationService(repoOf(rows), emailService, emailLayout, localeService, configuration, resolvedContact);
  return { service, mails, rows };
}

let warnings: string[];
beforeEach(() => {
  warnings = [];
  jest.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
    warnings.push(String(message));
  });
});
afterEach(() => jest.restoreAllMocks());

describe('IssueReportNotificationService', () => {
  it('sends the closure notice once, in the reporter language, with the title escaped', async () => {
    const { service, mails, rows } = setup();
    expect(await service.notifyPending()).toBe(1);
    expect(await service.notifyPending()).toBe(0);
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe('ada@example.com');
    expect(mails[0].subject).toBe('Ton signalement n°12 a été corrigé');
    expect(mails[0].html).toContain('« Save &lt;b&gt;fails&lt;/b&gt; »');
    expect(mails[0].html).not.toContain('<b>fails</b>');
    expect(mails[0].text).toContain('« Save <b>fails</b> »');
    expect(rows[0].notifiedAt).toBeInstanceOf(Date);
  });

  it('never sends twice for the same report, even when two runs hold the same row', async () => {
    const { service, mails, rows } = setup();
    const stale = { ...rows[0] };
    expect(await service.notify(rows[0])).toBe('sent');
    expect(await service.notify(stale)).toBe('taken');
    expect(mails).toHaveLength(1);
  });

  it('without a USER_CONTACT provider: no e-mail, one warning, rows left pending', async () => {
    const { service, mails, rows } = setup({ contact: null });
    expect(await service.notifyPending()).toBe(0);
    expect(await service.notifyPending()).toBe(0);
    expect(mails).toHaveLength(0);
    expect(warnings.filter((line) => line.includes('USER_CONTACT'))).toHaveLength(1);
    expect(rows[0].notifiedAt).toBeNull();
  });

  it('waits while the e-mail provider is "none"', async () => {
    const { service, mails, rows } = setup({ provider: 'none' });
    expect(await service.notifyPending()).toBe(0);
    expect(mails).toHaveLength(0);
    expect(rows[0].notifiedAt).toBeNull();
  });

  it('marks a report without address as handled, without sending', async () => {
    const { service, mails, rows } = setup({ contact: { emailOf: async () => null } });
    expect(await service.notify(rows[0])).toBe('no_address');
    expect(mails).toHaveLength(0);
    expect(rows[0].notifiedAt).toBeInstanceOf(Date);
  });

  it(`retries a failed send on later runs, then gives up after ${NOTIFY_MAX_ATTEMPTS} attempts`, async () => {
    const { service, mails, rows } = setup({ sendResults: [{ success: false, error: 'SMTP down' }] });
    for (let run = 1; run < NOTIFY_MAX_ATTEMPTS; run += 1) {
      await service.notifyPending();
      expect(rows[0].notifiedAt).toBeNull();
    }
    await service.notifyPending();
    expect(rows[0].notifiedAt).toBeInstanceOf(Date);
    expect(mails).toHaveLength(NOTIFY_MAX_ATTEMPTS);
    expect(await service.notifyPending()).toBe(0);
    expect(mails).toHaveLength(NOTIFY_MAX_ATTEMPTS);
  });

  it('never writes the address in a log line', async () => {
    const { service } = setup({ sendResults: [{ success: false, error: 'rejected ada@example.com' }] });
    await service.notifyPending();
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.join('\n')).not.toContain('ada@example.com');
  });

  it('falls back to the app default language when the reporter language lacks the keys', async () => {
    const { service, mails } = setup({ contact: { emailOf: async () => 'ada@example.com', localeOf: async () => 'de' } });
    await service.notifyPending();
    expect(mails[0].subject).toBe('Ton signalement n°12 a été corrigé');
  });

  it('words a dropped report and an unknown reason (generic closure) differently', async () => {
    const languages = ['en'];
    const { service } = setup();
    expect((await service.compose(report({ closedReason: 'dropped' }), languages)).subject).toBe('Your report #12 has been closed');
    expect((await service.compose(report({ closedReason: 'dropped' }), languages)).text).toContain('decided not to work on it');
    expect((await service.compose(report({ closedReason: null }), languages)).text).toContain('has been reviewed');
  });

  it('languageOf keeps the two-letter language of a locale code', () => {
    expect(languageOf('fr-FR')).toBe('fr');
    expect(languageOf('EN')).toBe('en');
    expect(languageOf('x')).toBeNull();
    expect(languageOf(null)).toBeNull();
  });

  it('every closure reason has its wording in both languages', () => {
    for (const dictionary of [en, fr] as Record<string, string>[]) {
      for (const reason of ['fixed', 'dropped', 'manual']) {
        expect(dictionary[`issueReport.email.${reason}.subject`]).toBeTruthy();
        expect(dictionary[`issueReport.email.${reason}.body`]).toContain('{1}');
      }
      expect(Object.keys(dictionary).sort()).toEqual(Object.keys(en).sort());
    }
  });
});
