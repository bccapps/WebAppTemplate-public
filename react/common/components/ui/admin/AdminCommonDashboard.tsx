/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import '../../../styles/tokens.css';
import React from 'react';
import { I18nLabel } from '@/modules_shared/common/components/ui/label/I18nLabel';
import { httpService } from '@/modules_shared/common/core/http/HttpService';
import { HttpResult } from '@/modules_shared/common/core/http/HttpResult';
import { configurationService } from '@/modules_shared/common/services/ConfigurationService';
import { i18n } from '@/modules_shared/common/core/i18n/I18n';

interface SystemInfoData {
  memory: { totalBytes: number; usedBytes: number; freeBytes: number; usagePercent: number };
  disk: { totalBytes: number; usedBytes: number; freeBytes: number; usagePercent: number };
}

function httpResultToPromise<T>(result: HttpResult): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    result
      .then((data: T) => resolve(data as T))
      .fail((err: unknown) => reject(err))
      .error((err: unknown) => reject(err))
      .notAuthorized((err: unknown) => reject(err));
  });
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
}

function getBarColor(percent: number): string {
  if (percent >= 90) return 'var(--common-admindashboard-bar-critical)';
  if (percent >= 70) return 'var(--common-admindashboard-bar-warning)';
  return 'var(--common-admindashboard-bar-ok)';
}

const AdminCommonDashboard: React.FC = () => {
  const [data, setData] = React.useState<SystemInfoData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const fetchData = async (): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const result = await httpResultToPromise<SystemInfoData>(
          httpService.get(`${configurationService.getApiUrl()}/admin/system-info`),
        );
        if (!cancelled) setData(result);
      } catch {
        if (!cancelled) setError(i18n.get('common.dashboard.common.error'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchData();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="empty-state">
        <I18nLabel id="common.state.loading" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="alert alert-error" role="alert">
        {error}
      </div>
    );
  }

  if (!data) return null;

  const cards = [
    {
      labelKey: 'common.dashboard.common.memory',
      used: data.memory.usedBytes,
      total: data.memory.totalBytes,
      free: data.memory.freeBytes,
      percent: data.memory.usagePercent,
    },
    {
      labelKey: 'common.dashboard.common.disk',
      used: data.disk.usedBytes,
      total: data.disk.totalBytes,
      free: data.disk.freeBytes,
      percent: data.disk.usagePercent,
    },
  ];

  return (
    <div className="page-stack">
      <h3 style={{ margin: '0 0 0.75rem' }}>
        <I18nLabel id="common.config.groups.general" />
      </h3>
      <div className="card-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '1rem' }}>
        {cards.map((card) => (
          <div
            key={card.labelKey}
            className="card"
            style={{
              padding: '1.25rem',
              borderRadius: 'var(--radius-md, 12px)',
              background: 'var(--common-admindashboard-card-bg)',
              border: '1px solid var(--common-admindashboard-border)',
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: '0.75rem', fontSize: '1rem' }}>
              <I18nLabel id={card.labelKey} />
            </div>

            <div
              style={{
                height: 8,
                borderRadius: 4,
                background: 'var(--common-admindashboard-border)',
                overflow: 'hidden',
                marginBottom: '0.75rem',
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${Math.min(card.percent, 100)}%`,
                  background: getBarColor(card.percent),
                  borderRadius: 4,
                  transition: 'width 0.4s ease',
                }}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', opacity: 0.8 }}>
              <span>
                <I18nLabel id="common.dashboard.common.used" />: {formatBytes(card.used)}
              </span>
              <span style={{ fontWeight: 600 }}>{card.percent.toFixed(1)}%</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', opacity: 0.6, marginTop: '0.25rem' }}>
              <span>
                <I18nLabel id="common.dashboard.common.free" />: {formatBytes(card.free)}
              </span>
              <span>
                <I18nLabel id="common.dashboard.common.total" />: {formatBytes(card.total)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default AdminCommonDashboard;
