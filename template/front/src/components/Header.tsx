/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import {
  AppBar,
  Badge,
  Box,
  IconButton,
  Popover,
  Stack,
  Toolbar,
  Tooltip,
  Typography,
} from '@mui/material';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import NotificationsRoundedIcon from '@mui/icons-material/NotificationsRounded';
import AdminPanelSettingsRoundedIcon from '@mui/icons-material/AdminPanelSettingsRounded';
import DashboardCustomizeRoundedIcon from '@mui/icons-material/DashboardCustomizeRounded';
import LogoutRoundedIcon from '@mui/icons-material/LogoutRounded';
import { detectLocalTrust, sessionAuth } from '@/modules_shared/common/auth/sessionAuth';
import { userManagementEnabled } from '@/plugins';
import { PluginHeaderActions } from '@/modules_shared/common/plugins/PluginHeaderActions';
import { SwitchLanguage } from '@/modules_shared/common/components/ui/languages/SwitchLanguage';
import { ThemeSwitch } from '@/modules_shared/common/components/ui/theme/ThemeSwitch';
import { Title } from './Title';
// {{#PWA}}
import { PwaInstallButton } from './PwaInstallButton';
// {{/PWA}}
import { I18nLabel } from '@/modules_shared/common/components/ui/label/I18nLabel';
import { useSessionKeys } from '@/modules_shared/common/hooks/useSessionKeys';

interface HeaderProps {
  alertsCount?: number;
}

export function Header({ alertsCount = 0 }: HeaderProps) {
  useSessionKeys(['user']);
  const isAdmin = sessionAuth.isAdmin();
  useEffect(() => {
    void detectLocalTrust(); // local trust mode: the admin menu appears without a key
  }, []);
  const [alertsAnchor, setAlertsAnchor] = useState<null | HTMLElement>(null);
  const popoverId = 'alerts-popover';

  return (
    <AppBar
      position="fixed"
      className="app-header"
      sx={{ zIndex: (theme) => theme.zIndex.drawer + 1, bgcolor: 'var(--header-background, #874848) !important', color: 'text.primary', display: 'flex', alignItems: 'center' }}
    >
      <Toolbar
        disableGutters
        sx={{
          minHeight: 64,
          height: 64,
          width: '100%',
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          alignItems: 'center',
          gap: 2,
          px: 2,
        }}
      >
        <Link to="/" style={{ display: 'inline-flex', alignItems: 'center' }}>
          <img style={{ height: 44, width: 'auto' }} src="/images/logo-main.svg" alt="Logo" />
        </Link>
        <Box sx={{ display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexGrow: 1, ml: 2, gap: 2, height: '100%' }}>
          <Title />
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Tooltip
              title={
                alertsCount > 0 ? (
                  <I18nLabel id="app.header.alerts" params={[alertsCount]} />
                ) : (
                  <I18nLabel id="app.header.alerts.none" />
                )
              }
            >
              <IconButton
                color="inherit"
                aria-describedby={popoverId}
                onClick={(event) => setAlertsAnchor(event.currentTarget)}
                sx={{
                  background: 'var(--header-pill, rgba(255,255,255,0.12))',
                  borderRadius: '14px',
                }}
              >
                <Badge
                  badgeContent={alertsCount}
                  color="error"
                  className="header-alert-badge"
                  invisible={alertsCount === 0}
                >
                  <NotificationsRoundedIcon fontSize="small" />
                </Badge>
              </IconButton>
            </Tooltip>
            <Popover
              id={popoverId}
              open={Boolean(alertsAnchor)}
              anchorEl={alertsAnchor}
              onClose={() => setAlertsAnchor(null)}
              anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
              transformOrigin={{ vertical: 'top', horizontal: 'right' }}
              slotProps={{
                paper: {
                  sx: {
                    p: 2,
                    minWidth: 220,
                    borderRadius: 2,
                    bgcolor: 'background.paper',
                  },
                },
              }}
            >
              <Stack spacing={1.5}>
                <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                  <I18nLabel id="app.header.alerts.title" />
                </Typography>
                <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                  <I18nLabel id="app.header.alerts.none" />
                </Typography>
              </Stack>
            </Popover>
            {isAdmin && (
              <Stack direction="row" spacing={0.5}>
                <Tooltip title={<I18nLabel id="common.nav.adminPage" />}>
                  <IconButton
                    color="inherit"
                    component={Link}
                    to="/admin/page"
                    sx={{
                      background: 'var(--header-pill, rgba(255,255,255,0.12))',
                      borderRadius: '14px',
                    }}
                  >
                    <AdminPanelSettingsRoundedIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
                <Tooltip title={<I18nLabel id="common.nav.adminDashboard" />}>
                  <IconButton
                    color="inherit"
                    component={Link}
                    to="/admin/dashboard"
                    sx={{
                      background: 'var(--header-pill, rgba(255,255,255,0.12))',
                      borderRadius: '14px',
                    }}
                  >
                    <DashboardCustomizeRoundedIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Stack>
            )}
            {isAdmin && !userManagementEnabled && sessionAuth.mode !== 'local-trust' && (
              <Tooltip title={<I18nLabel id="common.admin.tokenGate.logout" />}>
                <IconButton
                  color="inherit"
                  onClick={() => sessionAuth.clear()}
                  sx={{
                    background: 'var(--header-pill, rgba(255,255,255,0.12))',
                    borderRadius: '14px',
                  }}
                >
                  <LogoutRoundedIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
            {/* {{#PWA}} */}
            <PwaInstallButton />
            {/* {{/PWA}} */}
            <SwitchLanguage />
            <ThemeSwitch />
            {/* Header actions of the plugins (wallet button with `user`, cart with `commerce`, ...). */}
            <PluginHeaderActions placement="end" />
          </Box>
        </Box>
      </Toolbar>
    </AppBar>
  );
}
