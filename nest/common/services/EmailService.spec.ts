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
import { EmailService, SMTP_TIMEOUTS } from './EmailService';

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
