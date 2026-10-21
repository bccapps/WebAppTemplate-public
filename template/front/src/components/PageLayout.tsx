/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useState } from 'react';
import { Box, CssBaseline, Toolbar } from '@mui/material';
import { useLocation } from 'react-router-dom';
import { useTheme } from '@mui/material/styles';
import { Header } from './Header';
import { AppSidebar } from './AppSidebar';
import { resolvedRoutes } from './routes';
import { layoutForPath } from '@/modules_shared/common/plugins/routeLayout';

import '@/modules_shared/common/styles/theme_default.css';
import { Footer } from './Footer';
import { useSessionKeys } from '@/modules_shared/common/hooks/useSessionKeys';
import { sessionAuth } from '@/modules_shared/common/auth/sessionAuth';

interface PageLayoutProps {
  children?: React.ReactNode;
}

export function PageLayout({ children }: PageLayoutProps) {
  useSessionKeys(['user']);
  // Remount the page content on real login/logout: the children element reference is
  // unchanged across our re-renders, so React skips its subtree — a key change is the
  // only way a layout-level subscription can propagate (re-runs all page effects too).
  const sessionKey = sessionAuth.isAuth() ? String(sessionAuth.get()?.id ?? 'auth') : 'anon';
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const layout = layoutForPath(resolvedRoutes, useLocation().pathname);
  const theme = useTheme();
  const layoutBg =
    theme.palette.mode === 'dark' ? 'var(--background-dark)' : 'var(--background-light)';

  // `fullscreen` routes (see Router.tsx) render alone: no header, sidebar or footer.
  if (layout === 'fullscreen') {
    return <Box key={sessionKey} sx={{ minHeight: '100vh', bgcolor: layoutBg }}>{children}</Box>;
  }

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: layoutBg }}>
      <CssBaseline />
      <Header />
      <AppSidebar open={sidebarOpen} onToggle={() => setSidebarOpen((open) => !open)} layout={layout} />

      <Box
        component="main"
        sx={{
          flexGrow: 1,
          minWidth: 0,
          p: 3,
          minHeight: '100vh',
          bgcolor: layoutBg,
        }}
      >
        <Toolbar sx={{ minHeight: { xs: 72, sm: 80 } }} />
        <Box key={sessionKey} sx={{ position: 'relative' }}>
          {children}
        </Box>
        <Footer />
      </Box>
    </Box>
  );
}
