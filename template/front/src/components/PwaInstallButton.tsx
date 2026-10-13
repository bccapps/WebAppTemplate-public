/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { IconButton, Tooltip } from '@mui/material';
import InstallMobileRoundedIcon from '@mui/icons-material/InstallMobileRounded';
import { I18nLabel } from '@/modules_shared/common/components/ui/label/I18nLabel';
import { usePwaInstallPrompt } from '@/modules_shared/common/pwa/hooks/usePwaInstallPrompt';

/**
 * Header button offering to install the app. Rendered only when the browser fires
 * `beforeinstallprompt` (Chromium) or on iOS Safari, where installing goes through the Share menu
 * (the tooltip explains it). Hidden once the app is installed.
 */
export function PwaInstallButton() {
  const { canInstall, isIos, isInstalled, prompt } = usePwaInstallPrompt();
  if (isInstalled || (!canInstall && !isIos)) return null;
  const hintId = canInstall ? 'app.header.install' : 'app.header.install.ios';
  return (
    <Tooltip title={<I18nLabel id={hintId} />}>
      <IconButton
        color="inherit"
        onClick={() => void prompt()}
        sx={{ background: 'var(--header-pill, rgba(255,255,255,0.12))', borderRadius: '14px' }}
      >
        <InstallMobileRoundedIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  );
}
