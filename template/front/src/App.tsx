/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { ReactNode } from 'react';
import { CssBaseline } from '@mui/material';
import { ThemeModeProvider } from '@/modules_shared/common/components/ui/theme/ThemeModeProvider';
import { VisualThemeProvider } from '@/modules_shared/common/theme/VisualThemeContext';
import { ThemeShell } from '@/modules_shared/common/theme/ThemeShell';
import Router from './components/Router';
import { PreloaderGate } from '@/modules_shared/common/core/preload/PreloaderGate';
import { PageLayout } from '@/components/PageLayout';
import { buildPreloadPlan } from '@/modules_shared/common/core/preload/preloadPlan';
import { withPluginProviders } from '@/modules_shared/common/plugins/pluginProviders';
import { BrowserRouter } from 'react-router-dom';
import { appPlugins } from './plugins';
import { coreServices } from './config/coreServices';

interface AppProps {
  children?: ReactNode;
}

const preloadPlan = buildPreloadPlan(coreServices, appPlugins);

function App({ children }: AppProps) {
  return (
    <>
      {withPluginProviders(
        <ThemeModeProvider>
          <CssBaseline />
          <BrowserRouter>
            <PreloaderGate services={preloadPlan.blocking} background={preloadPlan.background}>
              <VisualThemeProvider>
                <ThemeShell appName="{{SITE_NAME}}">
                  {withPluginProviders(
                    <PageLayout>
                      {children ?? <Router />}
                    </PageLayout>,
                    appPlugins,
                    'inner',
                  )}
                </ThemeShell>
              </VisualThemeProvider>
            </PreloaderGate>
          </BrowserRouter>
        </ThemeModeProvider>,
        appPlugins,
      )}
    </>
  );
}

export default App;
