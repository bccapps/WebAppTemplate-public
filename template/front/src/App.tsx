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
import { configurationService } from './modules_shared/common/services/ConfigurationService';
import { cryptService } from '@/modules_shared/common/services/CryptService';
import { localeService } from '@/modules_shared/common/services/LocaleService';
import { BrowserRouter } from 'react-router-dom';
import { appPlugins } from './plugins';

interface AppProps {
  children?: ReactNode;
}

const withPreloadKey = <T,>(service: T, key: string): T => {
  (service as { preloadKey?: string }).preloadKey = key;
  return service;
};

// Common services + the ones declared by linked module plugins (e.g. UserService with `user`).
const preloadServices = [
  withPreloadKey(configurationService, 'ConfigurationService'),
  withPreloadKey(cryptService, 'CryptService'),
  withPreloadKey(localeService, 'LocaleService'),
  ...appPlugins.flatMap((p) => p.preload ?? []).map((entry) => withPreloadKey(entry.service, entry.key)),
];

/** Wrap `tree` with the plugin Providers; `appPlugins` is sorted by ascending `order` (first = outermost). */
function withPluginProviders(tree: ReactNode): ReactNode {
  return appPlugins.reduceRight<ReactNode>(
    (acc, plugin) => (plugin.Provider ? <plugin.Provider key={plugin.id}>{acc}</plugin.Provider> : acc),
    tree,
  );
}

function App({ children }: AppProps) {
  return (
    <>
      {withPluginProviders(
        <ThemeModeProvider>
          <CssBaseline />
          <BrowserRouter>
            <PreloaderGate services={preloadServices}>
              <VisualThemeProvider>
                <ThemeShell appName="{{SITE_NAME}}">
                  <PageLayout>
                    {children ?? <Router />}
                  </PageLayout>
                </ThemeShell>
              </VisualThemeProvider>
            </PreloaderGate>
          </BrowserRouter>
        </ThemeModeProvider>,
      )}
    </>
  );
}

export default App;
