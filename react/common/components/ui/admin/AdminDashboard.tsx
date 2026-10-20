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
import { AdminTokenGate } from '@/modules_shared/common/components/ui/admin/AdminTokenGate';
import { i18n } from '@/modules_shared/common/core/i18n/I18n';
import AdminCommonDashboard from './AdminCommonDashboard';
import '../../../styles/shared_ui.css';

/** Same contract as AdminPage: optional `isAvailable()` hides the dashboard at render time. */
type DashboardModule = { default: React.ComponentType; isAvailable?: () => boolean };

type DashboardEntry = {
  name: string;
  label: string;
  component: React.ComponentType;
  isAvailable?: () => boolean;
};

type ModuleDashboardEntry = {
  moduleId: string;
  components: DashboardEntry[];
};

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

const extractLabel = (path: string, prefix: string): string => {
  const filename = path.split('/').pop()?.replace('.tsx', '') ?? '';
  const raw = filename.replace(new RegExp(`^${prefix}`), '');
  return raw.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
};

const dashboardsByModule = Object.entries(moduleDashboardModules).reduce<Record<string, DashboardEntry[]>>(
  (acc, [path, mod]) => {
    const match = path.match(/\/modules(?:_shared)?\/(.+?)\//);
    if (!match) return acc;
    const moduleId = match[1];
    if (!acc[moduleId]) acc[moduleId] = [];
    if (mod?.default) {
      acc[moduleId].push({
        name: path.split('/').pop()?.replace('.tsx', '') ?? '',
        label: extractLabel(path, 'Dashboard'),
        component: mod.default,
        isAvailable: mod.isAvailable,
      });
    }
    return acc;
  },
  {},
);

const moduleDashboardEntries: ModuleDashboardEntry[] = Object.entries(dashboardsByModule)
  .map(([moduleId, components]) => ({ moduleId, components }))
  .filter((entry) => entry.components.length > 0)
  .sort((a, b) => a.moduleId.localeCompare(b.moduleId));

const resolveModuleLabel = (moduleId: string): string => {
  const key = `modules.${moduleId}.name`;
  const resolved = i18n.get(key);
  if (resolved && resolved !== key) return resolved;
  return moduleId
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
};

interface ModuleDashboardTabProps {
  entry: ModuleDashboardEntry;
  activeComponentName: string | null;
  isOpen: boolean;
  onSelect: (moduleId: string, componentName: string) => void;
  onToggle: (moduleId: string) => void;
  onClose: () => void;
}

/** One pill per module; a module with several dashboards opens a dropdown, one entry per `Dashboard*.tsx`. */
const ModuleDashboardTab: React.FC<ModuleDashboardTabProps> = ({
  entry,
  activeComponentName,
  isOpen,
  onSelect,
  onToggle,
  onClose,
}) => {
  const { moduleId, components } = entry;
  const isEntryActive = activeComponentName !== null;

  if (components.length === 1) {
    return (
      <button
        type="button"
        className={`tab-pill ${isEntryActive ? 'active' : ''}`}
        onClick={() => onSelect(moduleId, components[0].name)}
        aria-selected={isEntryActive}
        role="tab"
      >
        {resolveModuleLabel(moduleId)}
      </button>
    );
  }

  return (
    <div className="tab-dropdown">
      <button
        type="button"
        className={`tab-pill ${isEntryActive ? 'active' : ''}`}
        onClick={() => onToggle(moduleId)}
        aria-selected={isEntryActive}
        aria-expanded={isOpen}
        aria-haspopup="true"
        role="tab"
      >
        {resolveModuleLabel(moduleId)}
        <span className={`tab-pill-chevron ${isOpen ? 'open' : ''}`} aria-hidden>▾</span>
      </button>
      {isOpen && (
        <>
          <div className="tab-dropdown-backdrop" onClick={onClose} />
          <div className="tab-dropdown-menu">
            {components.map((comp) => (
              <button
                type="button"
                key={comp.name}
                className={`tab-dropdown-item ${activeComponentName === comp.name ? 'active' : ''}`}
                onClick={() => onSelect(moduleId, comp.name)}
              >
                <span className="dropdown-dot" />
                {comp.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

const AdminDashboardContent: React.FC = () => {
  // activeTab: 'global' | 'moduleId:ComponentName' — only the selected dashboard is mounted (and fetches).
  const [activeTab, setActiveTab] = React.useState<string>(GLOBAL_TAB);
  const [openDropdown, setOpenDropdown] = React.useState<string | null>(null);

  const modulesWithDashboards = React.useMemo<ModuleDashboardEntry[]>(
    () =>
      moduleDashboardEntries
        .map(({ moduleId, components }) => ({
          moduleId,
          components: components.filter((comp) => comp.isAvailable?.() ?? true),
        }))
        .filter((entry) => entry.components.length > 0),
    [],
  );

  const isGlobalTab = activeTab === GLOBAL_TAB;
  const [activeModuleId, activeComponentName] = isGlobalTab ? [null, null] : activeTab.split(':');
  const activeComponent = modulesWithDashboards
    .find((entry) => entry.moduleId === activeModuleId)
    ?.components.find((comp) => comp.name === activeComponentName);

  React.useEffect(() => {
    if (isGlobalTab || activeComponent) return;
    setActiveTab(GLOBAL_TAB);
  }, [isGlobalTab, activeComponent]);

  const selectGlobal = React.useCallback(() => {
    setActiveTab(GLOBAL_TAB);
    setOpenDropdown(null);
  }, []);

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
            onClick={selectGlobal}
            aria-selected={isGlobalTab}
            role="tab"
          >
            <I18nLabel id="common.dashboard.global" />
          </button>
          {modulesWithDashboards.map((entry) => (
            <ModuleDashboardTab
              key={entry.moduleId}
              entry={entry}
              activeComponentName={entry.moduleId === activeModuleId ? activeComponentName : null}
              isOpen={openDropdown === entry.moduleId}
              onSelect={selectModuleComponent}
              onToggle={toggleDropdown}
              onClose={closeDropdown}
            />
          ))}
        </div>
      </section>

      {isGlobalTab && (
        <section className="page-section tab-panel" aria-live="polite">
          <AdminCommonDashboard />
          {GlobalDashboardComponent && <GlobalDashboardComponent />}
        </section>
      )}

      {activeComponent ? (
        <section className="page-section tab-panel">
          {React.createElement(activeComponent.component)}
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
