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
import { ToastZone } from '@/modules_shared/common/components/ui/toast/ToastZone';
import { Loader } from '@/modules_shared/common/components/ui/loader/Loader';
import { resolvedRoutes } from './routes';

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
