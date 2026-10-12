/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { ConfigurationService } from './ConfigurationService';
import { ModuleConfigService } from './ModuleConfigService';

export type SendEmailOptions = {
  cc?: string;
  bcc?: string;
  replyTo?: string;
  from?: string;
  /**
   * Extra SMTP headers. Bulk senders use these to attach a provider correlation
   * id (`X-MJ-CustomID`, `X-Mailin-custom`) so opens, clicks and bounces can be
   * traced back to a recipient later.
   */
  headers?: Record<string, string>;
  /** Plain-text alternative. Improves deliverability on bulk sends. */
  text?: string;
  attachments?: Array<{
    filename: string;
    content: string | Buffer;
    contentType?: string;
  }>;
};

export type SendEmailResult = {
  success: boolean;
  messageId?: string;
  /** Raw SMTP acceptance line. Kept for diagnostics only — no provider documents its shape. */
  response?: string;
  error?: string;
};

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter: Transporter | null = null;
  private configHash: string = '';

  constructor(
    private readonly configurationService: ConfigurationService,
    private readonly moduleConfigService: ModuleConfigService,
  ) {}

  private getConfigValue(key: string): string {
    return String(this.moduleConfigService.getDecryptedValue(key) ?? '');
  }

  private buildConfigHash(): string {
    const keys = [
      'common_email_provider',
      'common_email_brevoApiKey',
      'common_email_brevoUser',
      'common_email_mailjetApiKey',
      'common_email_mailjetSecretKey',
      'common_email_smtpHost',
      'common_email_smtpPort',
      'common_email_smtpSecure',
      'common_email_smtpUser',
      'common_email_smtpPassword',
      'common_email_maxConnections',
      'common_email_ratePerSecond',
    ];
    return keys.map((k) => this.getConfigValue(k)).join('|');
  }

  /** Currently selected provider id: `none` | `brevo` | `mailjet` | `smtp`. */
  getProvider(): string {
    return this.getConfigValue('common_email_provider') || 'none';
  }

  /**
   * Connection pooling and client-side throttling for bulk sends.
   *
   * Neither Mailjet nor Brevo publishes an SMTP throughput figure you can design
   * against, so we cap ourselves conservatively and treat the relay's own 4xx
   * responses as the real back-pressure signal.
   */
  private getPoolOptions(): { pool: true; maxConnections: number; maxMessages: number; rateDelta: number; rateLimit: number } {
    const maxConnections = parseInt(this.getConfigValue('common_email_maxConnections'), 10) || 5;
    const ratePerSecond = parseInt(this.getConfigValue('common_email_ratePerSecond'), 10) || 10;
    return {
      pool: true,
      maxConnections,
      maxMessages: Infinity,
      rateDelta: 1000,
      rateLimit: ratePerSecond,
    };
  }

  private createTransport(): Transporter | null {
    const provider = this.getConfigValue('common_email_provider');

    if (provider === 'brevo') {
      const apiKey = this.getConfigValue('common_email_brevoApiKey');
      const user = this.getConfigValue('common_email_brevoUser');
      if (!apiKey || !user) {
        this.logger.warn('Brevo provider selected but credentials are missing');
        return null;
      }
      this.logger.log(`Brevo transport: user=${user}, apiKey=${apiKey.substring(0, 10)}...${apiKey.substring(apiKey.length - 4)} (len=${apiKey.length})`);
      return nodemailer.createTransport({
        host: 'smtp-relay.brevo.com',
        port: 587,
        secure: false,
        auth: { user, pass: apiKey },
        ...this.getPoolOptions(),
      });
    }

    if (provider === 'mailjet') {
      const apiKey = this.getConfigValue('common_email_mailjetApiKey');
      const secretKey = this.getConfigValue('common_email_mailjetSecretKey');
      if (!apiKey || !secretKey) {
        this.logger.warn('Mailjet provider selected but credentials are missing');
        return null;
      }
      return nodemailer.createTransport({
        host: 'in-v3.mailjet.com',
        port: 587,
        secure: false,
        auth: { user: apiKey, pass: secretKey },
        ...this.getPoolOptions(),
      });
    }

    if (provider === 'smtp') {
      const host = this.getConfigValue('common_email_smtpHost');
      const port = parseInt(this.getConfigValue('common_email_smtpPort'), 10) || 465;
      const secure = this.getConfigValue('common_email_smtpSecure') === 'true';
      const user = this.getConfigValue('common_email_smtpUser');
      const pass = this.getConfigValue('common_email_smtpPassword');
      if (!host) {
        this.logger.warn('SMTP provider selected but host is missing');
        return null;
      }
      return nodemailer.createTransport({
        host,
        port,
        secure,
        auth: user ? { user, pass } : undefined,
        ...this.getPoolOptions(),
      });
    }

    return null;
  }

  private getTransport(): Transporter | null {
    const hash = this.buildConfigHash();
    if (this.transporter && this.configHash === hash) {
      return this.transporter;
    }
    // Transports are pooled now, so a superseded one holds open SMTP sockets
    // until it is told to let go.
    this.transporter?.close?.();
    this.transporter = this.createTransport();
    this.configHash = hash;
    return this.transporter;
  }

  async sendEmail(
    to: string,
    subject: string,
    html: string,
    options?: SendEmailOptions,
  ): Promise<SendEmailResult> {
    const transport = this.getTransport();
    if (!transport) {
      const provider = this.getConfigValue('common_email_provider');
      const msg = provider === 'none'
        ? 'Email provider is disabled'
        : 'Email transport not configured properly';
      this.logger.warn(msg);
      return { success: false, error: msg };
    }

    const fromAddress = options?.from
      || this.buildFromAddress();

    try {
      const info = await transport.sendMail({
        from: fromAddress,
        to,
        subject,
        html,
        text: options?.text,
        cc: options?.cc,
        bcc: options?.bcc,
        replyTo: options?.replyTo,
        headers: options?.headers,
        attachments: options?.attachments,
      });
      this.logger.log(`Email sent to ${to}, messageId: ${info.messageId}`);
      return { success: true, messageId: info.messageId, response: info.response };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to send email to ${to}: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  }

  async sendTestEmail(to: string): Promise<SendEmailResult> {
    const subject = 'Test Email';
    const html = `
      <div style="font-family: sans-serif; padding: 20px;">
        <h2>Test Email</h2>
        <p>This is a test email to verify your email configuration is working correctly.</p>
        <p style="color: #666; font-size: 12px;">Sent at: ${new Date().toISOString()}</p>
      </div>
    `;
    return this.sendEmail(to, subject, html);
  }

  private buildFromAddress(): string {
    const address = this.getConfigValue('common_email_fromAddress');
    const name = this.getConfigValue('common_email_fromName');
    if (!address) return '';
    return name ? `"${name}" <${address}>` : address;
  }
}
