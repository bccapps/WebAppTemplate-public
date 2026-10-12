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
import Unauthorized from '@/modules_shared/common/components/ui/unauthorized/Unauthorized';
import { sessionAuth } from '@/modules_shared/common/auth/sessionAuth';
import { i18n } from '@/modules_shared/common/core/i18n/I18n';
import '@/styles/theme_default.css';

type AdminModule = { default: React.ComponentType };

type UserAdminComponentEntry = {
  name: string;
  label: string;
  component: React.ComponentType;
};

type ModuleUserAdminComponentMap = Record<string, UserAdminComponentEntry[]>;

const userAdminModules = {
  ...import.meta.glob<AdminModule>('/src/modules_shared/*/components/ui/UserAdmin*.tsx', {
    eager: true,
  }),
  ...import.meta.glob<AdminModule>('/src/modules/*/components/ui/UserAdmin*.tsx', {
    eager: true,
  }),
};

const extractLabel = (path: string, prefix: string): string => {
  const filename = path.split('/').pop()?.replace('.tsx', '') ?? '';
  const raw = filename.replace(new RegExp(`^${prefix}`), '');
  return raw.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
};

const userAdminComponentsByModule: ModuleUserAdminComponentMap = Object.entries(userAdminModules).reduce(
  (acc, [path, mod]) => {
    const match = path.match(/\/modules(?:_shared)?\/(.+?)\//);
    if (!match) return acc;
    const moduleId = match[1];
    if (!acc[moduleId]) acc[moduleId] = [];
    if (mod?.default) {
      const filename = path.split('/').pop()?.replace('.tsx', '') ?? '';
      acc[moduleId].push({
        name: filename,
        label: extractLabel(path, 'UserAdmin'),
        component: mod.default,
      });
    }
    return acc;
  },
  {} as ModuleUserAdminComponentMap
);

const resolveModuleLabel = (moduleId: string) => {
  const key = `modules.${moduleId}.name`;
  const resolved = i18n.get(key);
  if (resolved && resolved !== key) return resolved;
  return moduleId
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
};

type ModuleEntry = {
  moduleId: string;
  components: UserAdminComponentEntry[];
};

export const UserAdminPage: React.FC = () => {
  const isAuthenticated = sessionAuth.isAuth();

  // activeTab: 'moduleId:ComponentName'
  const [activeTab, setActiveTab] = React.useState<string | null>(null);
  const [openDropdown, setOpenDropdown] = React.useState<string | null>(null);

  const moduleEntries = React.useMemo<ModuleEntry[]>(() => {
    return Object.entries(userAdminComponentsByModule)
      .map(([moduleId, components]) => ({ moduleId, components }))
      .filter((entry) => entry.components.length > 0)
      .sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  }, []);

  // Auto-select first component of first module
  React.useEffect(() => {
    if (!moduleEntries.length) {
      setActiveTab(null);
      return;
    }
    if (!activeTab) {
      const first = moduleEntries[0];
      setActiveTab(`${first.moduleId}:${first.components[0].name}`);
      return;
    }
    // Validate current selection
    const tabParts = activeTab.includes(':') ? activeTab.split(':') : null;
    if (!tabParts) {
      const first = moduleEntries[0];
      setActiveTab(`${first.moduleId}:${first.components[0].name}`);
      return;
    }
    const entry = moduleEntries.find((e) => e.moduleId === tabParts[0]);
    if (!entry || !entry.components.some((c) => c.name === tabParts[1])) {
      const first = moduleEntries[0];
      setActiveTab(`${first.moduleId}:${first.components[0].name}`);
    }
  }, [activeTab, moduleEntries]);

  const tabParts = activeTab?.includes(':') ? activeTab.split(':') : null;
  const activeModuleId = tabParts?.[0] ?? null;
  const activeComponentName = tabParts?.[1] ?? null;
  const activeEntry = activeModuleId
    ? moduleEntries.find((e) => e.moduleId === activeModuleId)
    : null;
  const activeComponent = activeEntry?.components.find(
    (c) => c.name === activeComponentName
  );

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

  if (!isAuthenticated) {
    return <Unauthorized />;
  }

  return (
    <div className="page-stack">
      <section className="page-section">
        <div className="section-header">
          <div>
            <h2>
              <I18nLabel id="common.admin.users.title" />
            </h2>
            <p className="subtext">
              <I18nLabel id="common.admin.users.subtitle" />
            </p>
          </div>
        </div>

        {moduleEntries.length ? (
          <div className="tab-nav" role="tablist" aria-label="User admin navigation">
            {moduleEntries.map((entry) => {
              const isEntryActive = activeModuleId === entry.moduleId;
              const isOpen = openDropdown === entry.moduleId;
              const hasSingle = entry.components.length === 1;

              if (hasSingle) {
                return (
                  <button
                    type="button"
                    key={entry.moduleId}
                    className={`tab-pill ${isEntryActive ? 'active' : ''}`}
                    onClick={() => selectModuleComponent(entry.moduleId, entry.components[0].name)}
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
                        {entry.components.map((comp) => {
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
        ) : (
          <div className="empty-state">
            <I18nLabel id="common.admin.users.empty" />
          </div>
        )}
      </section>

      {activeComponent ? (
        <section className="page-section tab-panel">
          {React.createElement(activeComponent.component)}
        </section>
      ) : null}
    </div>
  );
};

export default UserAdminPage;
