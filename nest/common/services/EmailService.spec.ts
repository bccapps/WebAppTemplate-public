/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, expect, it, jest } from '@jest/globals';
import * as nodemailer from 'nodemailer';
import { EmailService, SMTP_TIMEOUTS, maskEmailAddresses, maskRecipients } from './EmailService';

const serviceWith = (config: Record<string, string>): EmailService =>
  new EmailService({} as never, { getDecryptedValue: (key: string) => config[key] ?? '' } as never);

describe('EmailService SMTP timeouts', () => {
  const configs: Record<string, Record<string, string>> = {
    smtp: { common_email_provider: 'smtp', common_email_smtpHost: 'relay.example.com', common_email_smtpPort: '465', common_email_smtpSecure: 'true' },
    brevo: { common_email_provider: 'brevo', common_email_brevoUser: 'u', common_email_brevoApiKey: 'k' },
    mailjet: { common_email_provider: 'mailjet', common_email_mailjetApiKey: 'a', common_email_mailjetSecretKey: 's' },
  };

  it.each(Object.keys(configs))('%s: a relay that does not answer fails fast instead of holding the request for minutes', async (provider) => {
    const create = jest.spyOn(nodemailer, 'createTransport').mockReturnValue({ sendMail: async () => ({}), close: () => undefined } as never);
    await serviceWith(configs[provider]).sendEmail('a@b.c', 's', '<p>x</p>');
    expect(create).toHaveBeenCalledWith(expect.objectContaining(SMTP_TIMEOUTS));
    create.mockRestore();
  });

  it('the bounds are far below a proxy timeout (100 s on Cloudflare)', () => {
    expect(SMTP_TIMEOUTS.connectionTimeout + SMTP_TIMEOUTS.greetingTimeout + SMTP_TIMEOUTS.socketTimeout).toBeLessThan(100_000);
  });

  it('reports the failure of an unreachable relay as an unsuccessful result', async () => {
    const send = jest.fn(async () => { throw new Error('Connection timeout'); });
    const create = jest.spyOn(nodemailer, 'createTransport').mockReturnValue({ sendMail: send, close: () => undefined } as never);
    const result = await serviceWith(configs.smtp).sendEmail('a@b.c', 's', '<p>x</p>');
    expect(result).toEqual({ success: false, error: 'Connection timeout' });
    create.mockRestore();
  });
});

describe('EmailService credentials in logs', () => {
  it('never logs any part of the Brevo key nor the SMTP login when the transport is created', async () => {
    const apiKey = 'xkeysib-0123456789abcdef0123456789abcdef-SECRETTAIL';
    const user = 'smtp-login@example.test';
    const service = serviceWith({ common_email_provider: 'brevo', common_email_brevoUser: user, common_email_brevoApiKey: apiKey });
    const logger = (service as unknown as { logger: { log: (m: string) => void; warn: (m: string) => void; error: (m: string) => void } }).logger;
    const spies = (['log', 'warn', 'error'] as const).map((level) => jest.spyOn(logger, level).mockImplementation(() => undefined));
    const create = jest.spyOn(nodemailer, 'createTransport').mockReturnValue({ sendMail: async () => ({ messageId: 'id-1', response: '250 OK' }), close: () => undefined } as never);
    await service.sendEmail('jean.dupont@example.fr', 's', '<p>x</p>');
    const lines = spies.flatMap((spy) => spy.mock.calls.map((call) => String(call[0]))).join('\n');
    expect(lines).toContain('Brevo transport configured');
    expect(lines).not.toContain('xkeysib');
    expect(lines).not.toContain(apiKey.slice(0, 10));
    expect(lines).not.toContain('SECRETTAIL');
    expect(lines).not.toContain(user);
    create.mockRestore();
    spies.forEach((spy) => spy.mockRestore());
  });
});

describe('EmailService log masking', () => {
  it('keeps the first character and the domain of every address in a text', () => {
    expect(maskEmailAddresses('550 5.1.1 <jean.dupont@example.fr>: Recipient address rejected')).toBe(
      '550 5.1.1 <j***@example.fr>: Recipient address rejected',
    );
    expect(maskEmailAddresses('no address here')).toBe('no address here');
  });

  it('lists the masked addresses of a recipient field, without the display names', () => {
    expect(maskRecipients('Jean Dupont <jean.dupont@example.fr>, marie@test.io')).toBe('j***@example.fr, m***@test.io');
    expect(maskRecipients('not an address')).toBe('***');
  });

  it('never logs a full recipient address', async () => {
    const service = serviceWith({ common_email_provider: 'smtp', common_email_smtpHost: 'relay.example.com', common_email_smtpPort: '465', common_email_smtpSecure: 'true' });
    const log = jest.spyOn((service as unknown as { logger: { log: (m: string) => void } }).logger, 'log').mockImplementation(() => undefined);
    const create = jest.spyOn(nodemailer, 'createTransport').mockReturnValue({
      sendMail: async () => ({ messageId: 'id-1', response: '250 OK' }),
      close: () => undefined,
    } as never);
    await service.sendEmail('jean.dupont@example.fr', 's', '<p>x</p>');
    const lines = log.mock.calls.map((call) => String(call[0])).join('\n');
    expect(lines).toContain('j***@example.fr');
    expect(lines).not.toContain('jean.dupont@example.fr');
    create.mockRestore();
    log.mockRestore();
  });
});

describe('EmailService per-message sender name', () => {
  const smtp = {
    common_email_provider: 'smtp', common_email_smtpHost: 'relay.example.com', common_email_smtpPort: '465', common_email_smtpSecure: 'true',
    common_email_fromAddress: 'noreply@example.com', common_email_fromName: 'Global',
  };

  const sentFrom = async (options?: { fromName?: string }): Promise<unknown> => {
    const send = jest.fn(async (_message: unknown) => ({ messageId: 'id', response: '250 OK' }));
    const create = jest.spyOn(nodemailer, 'createTransport').mockReturnValue({ sendMail: send, close: () => undefined } as never);
    await serviceWith(smtp).sendEmail('a@b.c', 's', '<p>x</p>', options);
    create.mockRestore();
    return (send.mock.calls[0][0] as { from: string }).from;
  };

  it('keeps the global sender name without an override', async () => {
    expect(await sentFrom()).toBe('"Global" <noreply@example.com>');
  });

  it('replaces the name but keeps the configured address', async () => {
    expect(await sentFrom({ fromName: 'Papang Labs' })).toBe('"Papang Labs" <noreply@example.com>');
  });

  it('strips quotes and line breaks from the override (header injection)', async () => {
    expect(await sentFrom({ fromName: 'Evil"\r\nBcc: x@y.z' })).toBe('"EvilBcc: x@y.z" <noreply@example.com>');
  });

  it('falls back to the global name when the override is blank', async () => {
    expect(await sentFrom({ fromName: '  ' })).toBe('"Global" <noreply@example.com>');
  });
});
