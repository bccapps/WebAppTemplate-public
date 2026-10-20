/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import '../../../styles/tokens.css';
import { useState, useEffect } from 'react';
import { Box, FormControl, IconButton, MenuItem, Select, Switch, Tooltip } from '@mui/material';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import LightModeIcon from '@mui/icons-material/LightMode';
import { useThemeMode } from './ThemeModeProvider';
import { I18nLabel } from '../label/I18nLabel';
import { i18n } from '../../../core/i18n/I18n';
import { themeService, ThemeDto } from '../../../services/ThemeService';

export function ThemeSwitch() {
  const { mode, toggleMode, setMode, themeCode, setThemeCode } = useThemeMode();
  const isDark = mode === 'dark';

  const [themes, setThemes] = useState<ThemeDto[]>([]);

  useEffect(() => {
    themeService.listActive()
      .then((data: ThemeDto[]) => setThemes(data ?? []))
      .fail(() => {})
      .error(() => {});
  }, []);

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0 }}>
      {themes.length > 1 && (
        <FormControl size="small" sx={{ minWidth: 120, mr: 1 }}>
          <Select
            value={themeCode}
            onChange={(e) => setThemeCode(e.target.value)}
            size="small"
            variant="outlined"
          >
            {themes.map((t) => (
              <MenuItem key={t.code} value={t.code}>
                {t.isDefault ? i18n.get('common.themes.default') : t.name}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      )}
      <Tooltip title={<I18nLabel id="common.theme.light" /> }>
        <span>
          <IconButton
            size="small"
            color="inherit"
            disableRipple
            onClick={() => setMode('light')}
            sx={{
              background: 'none !important',
              backgroundImage: 'none !important',
              color: isDark ? 'var(--common-themeswitch-icon-dark)' : 'var(--common-themeswitch-icon-light)',
              p: 0,
              '&:hover': { background: 'none !important', backgroundImage: 'none !important' },
              '&:active': { background: 'none !important', backgroundImage: 'none !important' },
            }}
          >
            <LightModeIcon fontSize="small" sx={{ color: isDark ? 'var(--common-themeswitch-icon-dark)' : 'var(--common-themeswitch-icon-light)' }} />
          </IconButton>
        </span>
      </Tooltip>
      <Switch
        size="small"
        checked={isDark}
        onChange={toggleMode}
        color="default"
        slotProps={{ input: { 'aria-label': i18n.get('common.theme.toggle') } }}
        sx={{
          mx: 0,
          '& .MuiSwitch-thumb': {
            backgroundColor: 'var(--button-gradient-start-light)'
          },
          '& .MuiSwitch-track': {
            backgroundColor: 'var(--button-gradient-end-light)',
            opacity: 1,
          },
          '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': {
            backgroundColor: 'var(--button-gradient-end-light)',
            opacity: 1,
          },
          '& .MuiSwitch-switchBase.Mui-checked .MuiSwitch-thumb': {
            backgroundColor: 'var(--button-gradient-start-light)'
          },
        }}
      />
      <Tooltip title={<I18nLabel id="common.theme.dark" /> }>
        <span>
          <IconButton
            size="small"
            color="inherit"
            disableRipple
            onClick={() => setMode('dark')}
            sx={{
              background: 'none !important',
              backgroundImage: 'none !important',
              color: isDark ? 'var(--common-themeswitch-icon-dark)' : 'var(--common-themeswitch-icon-light)',
              p: 0,
              '&:hover': { background: 'none !important', backgroundImage: 'none !important' },
              '&:active': { background: 'none !important', backgroundImage: 'none !important' },
            }}
          >
            <DarkModeIcon fontSize="small" sx={{ color: isDark ? 'var(--common-themeswitch-icon-dark)' : 'var(--common-themeswitch-icon-light)' }} />
          </IconButton>
        </span>
      </Tooltip>
    </Box>
  );
}


