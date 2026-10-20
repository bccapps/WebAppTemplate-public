/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import React from 'react';
import { I18nLabel } from '@/modules_shared/common/components/ui/label/I18nLabel';
import { sessionAuth } from '@/modules_shared/common/auth/sessionAuth';
import { AdminTokenGate } from '@/modules_shared/common/components/ui/admin/AdminTokenGate';
import { i18n } from '@/modules_shared/common/core/i18n/I18n';
import AdminCommonDashboard from './AdminCommonDashboard';
import '../../../styles/shared_ui.css';

/** Same contract as AdminPage: optional `isAvailable()` hides the dashboard at render time. */
type DashboardModule = { default: React.ComponentType; isAvailable?: () => boolean };

const GLOBAL_TAB = 'global';

const globalDashboardModules = import.meta.glob<DashboardModule>('/src/config/AdminCustomDashboard.tsx', {
  eager: true,
});
const GlobalDashboardComponent = Object.values(globalDashboardModules)[0]?.default ?? null;

const moduleDashboardModules = {
  ...import.meta.glob<DashboardModule>('/src/modules_shared/*/components/ui/Dashboard*.tsx', {
    eager: true,
  }),
  ...import.meta.glob<DashboardModule>('/src/modules/*/components/ui/Dashboard*.tsx', {
    eager: true,
  }),
};

const dashboardsByModule = Object.entries(moduleDashboardModules).reduce<
  Record<string, DashboardModule[]>
>((acc, [path, mod]) => {
  const match = path.match(/\/modules(?:_shared)?\/(.+?)\//);
  if (!match) {
    return acc;
  }
  const moduleId = match[1];
  if (!acc[moduleId]) {
    acc[moduleId] = [];
  }
  if (mod?.default) {
    acc[moduleId].push(mod);
  }
  return acc;
}, {});

const moduleDashboardEntries = Object.entries(dashboardsByModule)
  .map(([moduleId, components]) => ({
    moduleId,
    components,
  }))
  .filter((entry) => entry.components.length > 0)
  .sort((a, b) => a.moduleId.localeCompare(b.moduleId));

const AdminDashboardContent: React.FC = () => {
  const [activeTab, setActiveTab] = React.useState<string>(GLOBAL_TAB);

  const resolveModuleLabel = React.useCallback((moduleId: string) => {
    const key = `modules.${moduleId}.name`;
    const resolved = i18n.get(key);
    if (resolved && resolved !== key) return resolved;
    return moduleId
      .split(/[-_]/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }, []);

  const modulesWithDashboards = React.useMemo(
    () =>
      moduleDashboardEntries
        .map(({ moduleId, components }) => ({
          moduleId,
          components: components.filter((mod) => mod.isAvailable?.() ?? true).map((mod) => mod.default),
        }))
        .filter((entry) => entry.components.length > 0),
    [],
  );
  const hasGlobalDashboard = Boolean(GlobalDashboardComponent);
  const isGlobalTab = activeTab === GLOBAL_TAB;
  const selectedModuleEntry = modulesWithDashboards.find((entry) => entry.moduleId === activeTab);
  const isModuleTab = Boolean(selectedModuleEntry);

  React.useEffect(() => {
    if (activeTab === GLOBAL_TAB) return;
    if (modulesWithDashboards.some((entry) => entry.moduleId === activeTab)) return;
    setActiveTab(GLOBAL_TAB);
  }, [activeTab, modulesWithDashboards]);

  const selectTab = React.useCallback((value: string) => {
    setActiveTab(value);
  }, []);

  return (
    <div className="page-stack">
      <section className="page-section">
        <div className="section-header">
          <div>
            <h2>
              <I18nLabel id="common.dashboard.title" />
            </h2>
            <p className="subtext">
              <I18nLabel id="common.dashboard.subtitle" />
            </p>
          </div>
        </div>

        <div className="tab-nav" role="tablist" aria-label="Admin dashboard navigation">
          <button
            type="button"
            className={`tab-pill ${isGlobalTab ? 'active' : ''}`}
            onClick={() => selectTab(GLOBAL_TAB)}
            aria-selected={isGlobalTab}
            role="tab"
          >
            <I18nLabel id="common.dashboard.global" />
          </button>
          {modulesWithDashboards.map((entry) => {
            const isActive = activeTab === entry.moduleId;
            return (
              <button
                type="button"
                key={entry.moduleId}
                className={`tab-pill ${isActive ? 'active' : ''}`}
                onClick={() => selectTab(entry.moduleId)}
                aria-selected={isActive}
                role="tab"
              >
                {resolveModuleLabel(entry.moduleId)}
              </button>
            );
          })}
        </div>
      </section>

      {isGlobalTab && (
        <section className="page-section tab-panel" aria-live="polite">
          <AdminCommonDashboard />
          {hasGlobalDashboard && GlobalDashboardComponent && <GlobalDashboardComponent />}
        </section>
      )}

      {isModuleTab && selectedModuleEntry ? (
        <section className="page-section tab-panel">
          {selectedModuleEntry.components.length ? (
            <div className="page-stack">
              {selectedModuleEntry.components.map((Component, index) => (
                <section key={`${selectedModuleEntry.moduleId}-dashboard-${index}`} className="page-section">
                  <Component />
                </section>
              ))}
            </div>
          ) : (
            <div className="empty-state">
              <I18nLabel id="common.dashboard.module.empty" />
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
};

const AdminDashboard: React.FC = () => (
  <AdminTokenGate>
    <AdminDashboardContent />
  </AdminTokenGate>
);

export default AdminDashboard;
