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
import { httpService } from '@/modules_shared/common/core/http/HttpService';
import { configurationService } from '@/modules_shared/common/services/ConfigurationService';
import { HttpResult } from '@/modules_shared/common/core/http/HttpResult';
import { i18n } from '@/modules_shared/common/core/i18n/I18n';
import { moduleConfigService } from '@/modules_shared/common/services/ModuleConfigService';
import '../../../styles/shared_ui.css';

type ConfigRow = {
  name: string;
  value: string;
  description: string;
};

const normalizeSettings = (payload: any): ConfigRow[] => {
  if (!Array.isArray(payload)) return [];
  return payload
    .filter((item) => item && (item.name || item.key))
    .map((item) => ({
      name: item.name || item.key,
      value: item.value ?? '',
      description: item.description ?? item.label ?? '',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
};

/**
 * An `Admin*.tsx` file default-exports its component and may export `isAvailable()` to hide itself at
 * render time (e.g. a module whose API is remote: its admin lives in the remote app).
 */
type AdminModule = { default: React.ComponentType; isAvailable?: () => boolean };

const GENERAL_TAB = 'general';
const CUSTOM_TAB = 'custom';

const customAdminModules = import.meta.glob<AdminModule>('/src/config/AdminCustomPage.tsx', {
  eager: true,
});

const CustomAdminComponent = Object.values(customAdminModules)[0]?.default ?? null;
const hasCustomAdminComponent = Boolean(CustomAdminComponent);

type AdminComponentEntry = {
  name: string;
  label: string;
  component: React.ComponentType;
  isAvailable?: () => boolean;
};

type ModuleAdminComponentMap = Record<string, AdminComponentEntry[]>;

const moduleAdminComponents = {
  ...import.meta.glob<AdminModule>('/src/modules_shared/*/components/ui/Admin*.tsx', {
    eager: true,
  }),
  ...import.meta.glob<AdminModule>('/src/modules/*/components/ui/Admin*.tsx', {
    eager: true,
  }),
};

const extractLabel = (path: string, prefix: string): string => {
  const filename = path.split('/').pop()?.replace('.tsx', '') ?? '';
  const raw = filename.replace(new RegExp(`^${prefix}`), '');
  return raw.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
};

const adminComponentsByModule: ModuleAdminComponentMap = Object.entries(moduleAdminComponents).reduce<ModuleAdminComponentMap>(
  (acc, [path, mod]) => {
    const match = path.match(/\/modules(?:_shared)?\/(.+?)\//);
    if (!match) return acc;
    const moduleId = match[1];
    if (!acc[moduleId]) acc[moduleId] = [];
    if (mod?.default) {
      const filename = path.split('/').pop()?.replace('.tsx', '') ?? '';
      acc[moduleId].push({
        name: filename,
        label: extractLabel(path, 'Admin'),
        component: mod.default,
        isAvailable: mod.isAvailable,
      });
    }
    return acc;
  },
  {} as ModuleAdminComponentMap
);

type ModuleDisplayEntry = {
  moduleId: string;
  adminComponents: AdminComponentEntry[];
};

const AdminPageContent: React.FC = () => {
  const isAdmin = sessionAuth.isAdmin();

  // activeTab: 'general' | 'custom' | 'moduleId:ComponentName'
  const [activeTab, setActiveTab] = React.useState<string>(GENERAL_TAB);
  const [openDropdown, setOpenDropdown] = React.useState<string | null>(null);

  const [globalRows, setGlobalRows] = React.useState<ConfigRow[]>([]);
  const [globalOriginalRows, setGlobalOriginalRows] = React.useState<ConfigRow[]>([]);
  const [globalFilter, setGlobalFilter] = React.useState('');
  const [globalLoading, setGlobalLoading] = React.useState(true);
  const [globalSaving, setGlobalSaving] = React.useState(false);
  const [globalError, setGlobalError] = React.useState<string | null>(null);
  const [globalSuccess, setGlobalSuccess] = React.useState(false);
  const [moduleConfigKeys, setModuleConfigKeys] = React.useState<Set<string>>(new Set());

  const sortRows = React.useCallback((rows: ConfigRow[]) => [...rows].sort((a, b) => a.name.localeCompare(b.name)), []);

  const getConfigEndpoint = React.useCallback(() => {
    return `${configurationService.getApiUrl()}/admin/configurations`;
  }, []);

  const httpResultToPromise = React.useCallback(<T,>(result: HttpResult) => {
    return new Promise<T>((resolve, reject) => {
      result
        .then((data) => resolve(data as T))
        .fail((err) => reject(err))
        .error((err) => reject(err))
        .notAuthorized((err) => reject(err));
    });
  }, []);

  const filteredGlobalRows = React.useMemo(() => {
    if (!globalFilter) return globalRows;
    const needle = globalFilter.toLowerCase();
    return globalRows.filter(
      (row) => row.name.toLowerCase().includes(needle) || row.description.toLowerCase().includes(needle)
    );
  }, [globalFilter, globalRows]);

  const hasGlobalChanges = React.useMemo(
    () => JSON.stringify(globalRows) !== JSON.stringify(globalOriginalRows),
    [globalRows, globalOriginalRows]
  );

  const resolveModuleLabel = React.useCallback((moduleId: string) => {
    const key = `modules.${moduleId}.name`;
    const resolved = i18n.get(key);
    if (resolved && resolved !== key) return resolved;
    return moduleId
      .split(/[-_]/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }, []);

  const formatError = React.useCallback(
    (err?: any) =>
      typeof err === 'string'
        ? err
        : err?.message || err?.details || i18n.get('common.error.generic'),
    []
  );

  const fetchGlobalSettings = React.useCallback(async () => {
    if (!isAdmin) {
      setGlobalLoading(false);
      return;
    }
    setGlobalLoading(true);
    setGlobalError(null);
    setGlobalSuccess(false);
    try {
      // Load module config schemas to know which keys are managed by modules
      const schemas = await moduleConfigService.getSchemas().catch(() => []);
      const managedKeys = new Set<string>();
      for (const schema of schemas) {
        for (const field of schema.fields) {
          managedKeys.add(field.key);
        }
      }
      setModuleConfigKeys(managedKeys);

      const data = await httpResultToPromise<any[]>(httpService.get(getConfigEndpoint()));
      // Filter out keys managed by module configs — they have their own admin sections
      const filtered = normalizeSettings(data).filter((row) => !managedKeys.has(row.name));
      const normalized = sortRows(filtered);
      setGlobalRows(normalized);
      setGlobalOriginalRows(normalized);
    } catch (err) {
      setGlobalError(formatError(err));
    } finally {
      setGlobalLoading(false);
    }
  }, [formatError, getConfigEndpoint, httpResultToPromise, isAdmin, sortRows]);

  React.useEffect(() => {
    fetchGlobalSettings();
  }, [fetchGlobalSettings]);

  const handleGlobalChange = React.useCallback((name: string, value: string) => {
    setGlobalRows((prev) =>
      prev.map((row) =>
        row.name === name
          ? {
              ...row,
              value,
            }
          : row
      )
    );
    setGlobalSuccess(false);
  }, []);

  const handleGlobalSave = React.useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!hasGlobalChanges || globalSaving) return;
      setGlobalSaving(true);
      setGlobalError(null);
      const payload = globalRows.map((row) => ({
        name: row.name,
        value: row.value,
        description: row.description,
      }));
      try {
        const data = await httpResultToPromise<any[]>(httpService.put(getConfigEndpoint(), payload));
        const normalized = sortRows(normalizeSettings(data) ?? globalRows);
        setGlobalRows(normalized);
        setGlobalOriginalRows(normalized);
        setGlobalSuccess(true);
      } catch (err) {
        setGlobalError(formatError(err));
      } finally {
        setGlobalSaving(false);
      }
    },
    [formatError, getConfigEndpoint, globalRows, globalSaving, hasGlobalChanges, httpResultToPromise, sortRows]
  );

  const handleGlobalReset = React.useCallback(() => {
    setGlobalRows(globalOriginalRows);
    setGlobalSuccess(false);
  }, [globalOriginalRows]);

  const moduleDisplayEntries = React.useMemo<ModuleDisplayEntry[]>(() => {
    return Object.entries(adminComponentsByModule)
      .map(([moduleId, comps]) => ({ moduleId, adminComponents: comps.filter((c) => c.isAvailable?.() ?? true) }))
      .filter(({ adminComponents }) => adminComponents.length > 0)
      .sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  }, []);

  // Derive active state from compound tab key
  const isGeneralTab = activeTab === GENERAL_TAB;
  const isCustomTab = hasCustomAdminComponent && activeTab === CUSTOM_TAB;
  const tabParts = activeTab.includes(':') ? activeTab.split(':') : null;
  const activeModuleId = tabParts?.[0] ?? null;
  const activeComponentName = tabParts?.[1] ?? null;
  const activeModuleEntry = activeModuleId
    ? moduleDisplayEntries.find((e) => e.moduleId === activeModuleId)
    : null;
  const activeComponent = activeModuleEntry?.adminComponents.find(
    (c) => c.name === activeComponentName
  );
  const isModuleTab = Boolean(activeComponent);

  // Fallback to general if active tab is invalid
  React.useEffect(() => {
    if (isGeneralTab || isCustomTab || isModuleTab) return;
    setActiveTab(GENERAL_TAB);
  }, [isGeneralTab, isCustomTab, isModuleTab]);

  const selectModuleComponent = React.useCallback((moduleId: string, componentName: string) => {
    setActiveTab(`${moduleId}:${componentName}`);
    setOpenDropdown(null);
  }, []);

  const toggleDropdown = React.useCallback((moduleId: string) => {
    setOpenDropdown((prev) => (prev === moduleId ? null : moduleId));
  }, []);

  const closeDropdown = React.useCallback(() => {
    setOpenDropdown(null);
  }, []);

  return (
    <div className="page-stack">
      <section className="page-section">
        <div className="section-header">
          <div>
            <h2>
              <I18nLabel id="common.config.title" />
            </h2>
            <p className="subtext">
              <I18nLabel id="common.config.subtitle" />
            </p>
          </div>
        </div>

        <div className="tab-nav" role="tablist" aria-label="Admin configuration navigation">
          <button
            type="button"
            className={`tab-pill ${isGeneralTab ? 'active' : ''}`}
            onClick={() => { setActiveTab(GENERAL_TAB); closeDropdown(); }}
            aria-selected={isGeneralTab}
            role="tab"
          >
            <I18nLabel id="common.general" />
          </button>
          {hasCustomAdminComponent && (
            <button
              type="button"
              className={`tab-pill ${isCustomTab ? 'active' : ''}`}
              onClick={() => { setActiveTab(CUSTOM_TAB); closeDropdown(); }}
              aria-selected={isCustomTab}
              role="tab"
            >
              <I18nLabel id="custom.app.name" />
            </button>
          )}
          {moduleDisplayEntries.map((entry) => {
            const isEntryActive = activeModuleId === entry.moduleId;
            const isOpen = openDropdown === entry.moduleId;
            const hasSingle = entry.adminComponents.length === 1;

            if (hasSingle) {
              return (
                <button
                  type="button"
                  key={entry.moduleId}
                  className={`tab-pill ${isEntryActive ? 'active' : ''}`}
                  onClick={() => selectModuleComponent(entry.moduleId, entry.adminComponents[0].name)}
                  aria-selected={isEntryActive}
                  role="tab"
                >
                  {resolveModuleLabel(entry.moduleId)}
                </button>
              );
            }

            return (
              <div key={entry.moduleId} className="tab-dropdown">
                <button
                  type="button"
                  className={`tab-pill ${isEntryActive ? 'active' : ''}`}
                  onClick={() => toggleDropdown(entry.moduleId)}
                  aria-selected={isEntryActive}
                  aria-expanded={isOpen}
                  aria-haspopup="true"
                  role="tab"
                >
                  {resolveModuleLabel(entry.moduleId)}
                  <span className={`tab-pill-chevron ${isOpen ? 'open' : ''}`} aria-hidden>▾</span>
                </button>
                {isOpen && (
                  <>
                    <div className="tab-dropdown-backdrop" onClick={closeDropdown} />
                    <div className="tab-dropdown-menu">
                      {entry.adminComponents.map((comp) => {
                        const isItemActive = isEntryActive && activeComponentName === comp.name;
                        return (
                          <button
                            type="button"
                            key={comp.name}
                            className={`tab-dropdown-item ${isItemActive ? 'active' : ''}`}
                            onClick={() => selectModuleComponent(entry.moduleId, comp.name)}
                          >
                            <span className="dropdown-dot" />
                            {comp.label}
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {isGeneralTab && (
        <section className="page-section tab-panel" aria-live="polite">
          <div className="section-header" style={{ gap: '0.75rem', flexWrap: 'wrap' }}>
            <label style={{ flex: 1, minWidth: '220px' }}>
              <span className="stat-label">
                <I18nLabel id="common.admin.general.home.search" />
              </span>
              <input
                value={globalFilter}
                onChange={(event) => setGlobalFilter(event.target.value)}
                placeholder="configKey"
              />
            </label>
            <span className="admin-tab-counter">
              {filteredGlobalRows.length} / {globalRows.length}
            </span>
            <button
              type="button"
              className="ghost-btn"
              onClick={fetchGlobalSettings}
              disabled={globalLoading}
            >
              <span aria-hidden>⟳</span>
              <I18nLabel id="common.refresh" />
            </button>
          </div>

          {globalError ? (
            <div className="alert alert--error" role="alert">
              {globalError}
            </div>
          ) : null}
          {globalSuccess ? (
            <div className="alert alert--success" role="alert">
              <I18nLabel id="common.admin.general.home.saveSuccess" />
            </div>
          ) : null}

          {globalLoading ? (
            <div className="empty-state">
              <I18nLabel id="common.loading" />
            </div>
          ) : (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>
                      <I18nLabel id="common.admin.general.home.table.key" />
                    </th>
                    <th>
                      <I18nLabel id="common.admin.general.home.table.value" />
                    </th>
                    <th>
                      <I18nLabel id="common.bugReport.description" />
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredGlobalRows.length === 0 ? (
                    <tr>
                      <td colSpan={3} style={{ textAlign: 'center' }}>
                        <I18nLabel id="common.admin.general.home.empty" />
                      </td>
                    </tr>
                  ) : (
                    filteredGlobalRows.map((row) => {
                      const isBool = row.value === 'true' || row.value === 'false';
                      return (
                        <tr key={row.name}>
                          <td>
                            <code>{row.name}</code>
                          </td>
                          <td>
                            {isBool ? (
                              <input
                                type="checkbox"
                                role="switch"
                                checked={row.value === 'true'}
                                onChange={(e) => handleGlobalChange(row.name, e.target.checked ? 'true' : 'false')}
                              />
                            ) : (
                              <input
                                value={row.value}
                                onChange={(event) => handleGlobalChange(row.name, event.target.value)}
                              />
                            )}
                          </td>
                          <td>
                            <input value={row.description} disabled readOnly />
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          )}

          <form className="section-actions" style={{ justifyContent: 'flex-end' }} onSubmit={handleGlobalSave}>
            <button
              type="button"
              className="outline-btn"
              onClick={handleGlobalReset}
              disabled={!hasGlobalChanges || globalSaving}
            >
              <I18nLabel id="common.forms.reset" />
            </button>
            <button type="submit" className="primary-btn" disabled={!hasGlobalChanges || globalSaving}>
              {globalSaving ? (
                <span className="button-spinner" aria-hidden />
              ) : (
                <I18nLabel id="common.save" />
              )}
            </button>
          </form>
        </section>
      )}

      {isCustomTab && CustomAdminComponent ? (
        <section className="page-section tab-panel">
          <CustomAdminComponent />
        </section>
      ) : null}

      {isModuleTab && activeComponent ? (
        <section className="page-section">
          {React.createElement(activeComponent.component)}
        </section>
      ) : null}
    </div>
  );
};

export const AdminPage: React.FC = () => (
  <AdminTokenGate>
    <AdminPageContent />
  </AdminTokenGate>
);

export default AdminPage;
