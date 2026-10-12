/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import React from 'react';
import ModuleConfigForm from '@/modules_shared/common/components/ui/ModuleConfigForm';
import { i18n } from '@/modules_shared/common/core/i18n/I18n';
import { httpService } from '@/modules_shared/common/core/http/HttpService';
import { configurationService } from '@/modules_shared/common/services/ConfigurationService';

const AdminCommunicationChannels: React.FC = () => {
  const [recipient, setRecipient] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const [testResult, setTestResult] = React.useState<{ success: boolean; message: string } | null>(null);

  const handleSendTest = React.useCallback(async () => {
    if (!recipient || sending) return;
    setSending(true);
    setTestResult(null);
    try {
      await new Promise<void>((resolve, reject) => {
        httpService
          .post(configurationService.getApiUrl() + '/admin/email/test', { to: recipient })
          .then((data: { success?: boolean; error?: string }) => {
            if (data?.success) {
              setTestResult({ success: true, message: i18n.get('common.email.test.success') });
              resolve();
            } else {
              setTestResult({ success: false, message: data?.error || i18n.get('common.email.test.fail') });
              resolve();
            }
          })
          .fail((err: { message?: string }) => {
            setTestResult({ success: false, message: err?.message || i18n.get('common.email.test.fail') });
            reject(err);
          })
          .error((err: { message?: string }) => {
            setTestResult({ success: false, message: err?.message || i18n.get('common.email.test.fail') });
            reject(err);
          })
          .notAuthorized(() => {
            setTestResult({ success: false, message: i18n.get('common.error.unauthorized') });
            reject(new Error('unauthorized'));
          });
      });
    } catch {
      // error already set in handlers
    } finally {
      setSending(false);
    }
  }, [recipient, sending]);

  return (
    <div className="page-stack">
      {/* Site identity, social channels and image storage sit alongside the
          provider settings: they are what outbound content — e-mail headers,
          footers, permalinks, inline images — is built from, so an admin
          configures the whole outbound story here. */}
      <ModuleConfigForm moduleId="common" groups={['email', 'brand', 'social', 'storage']} />

      <article className="page-subsection">
        <div className="section-header">
          <h3>{i18n.get('common.email.test.title')}</h3>
        </div>

        {testResult && (
          <div
            className={testResult.success ? 'alert alert--success' : 'alert alert--error'}
            role="alert"
          >
            {testResult.message}
          </div>
        )}

        <div className="form-grid">
          <label className="field">
            <span className="stat-label">{i18n.get('common.email.test.recipient')}</span>
            <input
              type="email"
              value={recipient}
              onChange={(e) => {
                setRecipient(e.target.value);
                setTestResult(null);
              }}
              placeholder={i18n.get('common.email.test.recipient.placeholder')}
              disabled={sending}
            />
          </label>
        </div>

        <div className="section-actions" style={{ justifyContent: 'flex-end' }}>
          <button
            type="button"
            className="outline-btn"
            onClick={handleSendTest}
            disabled={!recipient || sending}
          >
            {sending ? <span className="button-spinner" aria-hidden /> : i18n.get('common.email.test.send')}
          </button>
        </div>
      </article>
    </div>
  );
};

export default AdminCommunicationChannels;
