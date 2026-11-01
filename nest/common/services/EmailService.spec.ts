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
