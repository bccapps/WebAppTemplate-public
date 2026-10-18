/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, it, expect } from '@jest/globals';
import type { Request } from 'express';
import { BugReportController } from './BugReportController';
import { EmailService } from '../services/EmailService';
import { ModuleConfigService } from '../services/ModuleConfigService';

describe('BugReportController', () => {
  it('escapes the reported fields and takes the user id from the session', async () => {
    const sent: string[] = [];
    const email = { sendEmail: async (_to: string, _subject: string, html: string) => { sent.push(html); return { success: true }; } };
    const config = { getDecryptedValue: () => 'admin@example.com' };
    const controller = new BugReportController(email as unknown as EmailService, config as unknown as ModuleConfigService);
    const request = { user: { id: 7 }, body: { uid: 99 } } as unknown as Request;
    await controller.sendBugReport({ subject: '<b>x</b>', description: '<a href="https://evil">click</a>', email: '' }, request);
    expect(sent[0]).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(sent[0]).not.toContain('<a href="https://evil">');
    expect(sent[0]).toContain('>7</td>');
  });
});
