/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import Home from './pages/Home';
import AdminPage from '@/modules_shared/common/components/ui/admin/AdminPage';
import AdminDashboard from '@/modules_shared/common/components/ui/admin/AdminDashboard';
import { ToastZone } from '@/modules_shared/common/components/ui/toast/ToastZone';
import { Loader } from '@/modules_shared/common/components/ui/loader/Loader';
import { resolveRoutes } from '@/modules_shared/common/plugins/resolveRoutes';
import type { PluginRoute } from '@/modules_shared/common/plugins/AppPlugin';
import LegalMentions from './pages/LegalMentions';
import Confidentiality from './pages/Confidentiality';
import UsageConditions from './pages/UsageConditions';
import { appPlugins } from '@/plugins';
import { pluginRouteOverrides } from '@/config/pluginRoutes';

// Routes of the app. Contract (also for plugins): { path, element | lazy, guard?, layout?: 'page' | 'fullscreen' | 'admin' }
// - `lazy: () => import('./pages/Big')` code-splits (rendered inside the Suspense below);
// - `guard: RequireAdmin | RequireAuth | RequireFeature('id')` (react/common/plugins/guards);
// - `layout`: `fullscreen` renders without header, sidebar and footer; `admin` adds the admin menu to the sidebar.
const appRoutes: PluginRoute[] = [
  { path: '/app', element: <Home /> },
  { path: '/legal-mentions', element: <LegalMentions /> },
  { path: '/confidentiality', element: <Confidentiality /> },
  { path: '/usage-conditions', element: <UsageConditions /> },
  { path: '/admin/page', element: <AdminPage />, layout: 'admin' },
  { path: '/admin/dashboard', element: <AdminDashboard />, layout: 'admin' },
];

/**
 * App routes + plugin routes after the overrides of `config/pluginRoutes.ts`. A path declared twice throws in dev
 * (and is logged in production, first one wins). `PageLayout` reads it to pick the layout of the current page.
 */
export const resolvedRoutes = resolveRoutes({
  appRoutes,
  plugins: appPlugins,
  overrides: pluginRouteOverrides,
  strict: import.meta.env.DEV,
});

function Router() {
  return (
    <>
      <ToastZone />
      <Suspense fallback={<Loader logoSrc="/favicon.svg" />}>
        <Routes>
          {resolvedRoutes.map((r) => (
            <Route key={r.path} path={r.path} element={r.element} />
          ))}
        </Routes>
      </Suspense>
    </>
  );
}

export default Router;
