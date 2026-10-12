/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Route, Routes } from 'react-router-dom';
import Home from './pages/Home';
import AdminPage from '@/modules_shared/common/components/ui/admin/AdminPage';
import AdminDashboard from '@/modules_shared/common/components/ui/admin/AdminDashboard';
import { ToastZone } from '@/modules_shared/common/components/ui/toast/ToastZone';
import LegalMentions from './pages/LegalMentions';
import Confidentiality from './pages/Confidentiality';
import UsageConditions from './pages/UsageConditions';
import { appPlugins } from '@/plugins';

function Router() {
  return (
    <>
      <ToastZone />
      <Routes>
        <Route path="/app" element={<Home />} />
        <Route path="/legal-mentions" element={<LegalMentions />} />
        <Route path="/confidentiality" element={<Confidentiality />} />
        <Route path="/usage-conditions" element={<UsageConditions />} />
        <Route path="/admin/page" element={<AdminPage />} />
        <Route path="/admin/dashboard" element={<AdminDashboard />} />
        {appPlugins.flatMap((p) => [...(p.routes ?? []), ...(p.adminRoutes ?? [])]).map((r) => (
          <Route key={r.path} path={r.path} element={r.element} />
        ))}
      </Routes>
    </>
  );
}

export default Router;
