/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import '../../../styles/tokens.css';
import { useCallback, useEffect, useState } from 'react';
import { IconButton, Menu, MenuItem, Tooltip, ListItemIcon, ListItemText } from '@mui/material';
import LanguageIcon from '@mui/icons-material/Language';
import { useThemeMode } from '../theme/ThemeModeProvider';
import CheckIcon from '@mui/icons-material/Check';
import { i18n } from '../../../core/i18n/I18n';
import { localeService } from '../../../services/LocaleService';
import { sessionAuth } from '../../../auth/sessionAuth';
import { I18nLabel } from '../../../components/ui/label/I18nLabel';

export const SwitchLanguage = () => {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const [currentLang, setCurrentLang] = useState(i18n.getLang());
  const [languages, setLanguages] = useState<string[]>(() => i18n.getLangs());
  const open = Boolean(anchorEl);
  const { mode } = useThemeMode();
  const isDark = mode === 'dark';
  const iconColor = isDark ? 'var(--common-switchlanguage-icon-dark)' : 'var(--common-switchlanguage-icon-light)';

  useEffect(() => {
    const refreshLanguages = () => {
      const langs = i18n.getLangs();
      if (langs.length > 0) {
        setLanguages(langs);
      }
    };
    refreshLanguages();
    const uuid = i18n.addEventListener('languageChanged', (payload: any) => {
      const lang = typeof payload === 'string' ? payload : payload?.lang;
      if (lang) {
        setCurrentLang(lang);
      }
      refreshLanguages();
    });
    return () => {
      i18n.removeEventListerner(uuid);
    };
  }, []);

  const handleOpen = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handleClose = () => setAnchorEl(null);

  const handleSelect = useCallback(
    (lang: string) => {
      setAnchorEl(null);
      // init() only fetches the active language's payload (PERFORMANCE_PLAN.md
      // §1.3) — make sure the target language's labels are loaded before
      // switching to it, otherwise they'd render as raw keys until reload.
      // A no-op (resolves immediately) if already loaded.
      void localeService.ensureLangLoaded(lang).finally(() => {
        i18n.setLang(lang);
        if (sessionAuth.isAuth()) {
          sessionAuth.setLocale(lang);
        }
      });
    },
    []
  );

  return (
    <>
      <Tooltip title={<I18nLabel id="common.language.select" />}>
        <IconButton
          size="small"
          onClick={handleOpen}
          aria-haspopup="true"
          aria-controls={open ? 'language-menu' : undefined}
          aria-expanded={open ? 'true' : undefined}
          sx={{
            color: iconColor,
            backgroundColor: 'transparent !important',
            border: 'none',
            m: 0,
            p: 0.5,
            '&:hover': {
              backgroundColor: isDark
                ? 'var(--common-switchlanguage-hover-dark)'
                : 'var(--common-switchlanguage-hover-light)',
            },
          }}
        >
          <LanguageIcon fontSize="small" sx={{ color: iconColor }} />
        </IconButton>
      </Tooltip>
      <Menu
        id="language-menu"
        anchorEl={anchorEl}
        open={open}
        onClose={handleClose}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        {languages.map((lang) => {
          const active = lang === currentLang;
          return (
            <MenuItem key={lang} selected={active} onClick={() => handleSelect(lang)}>
              {active && (
                <ListItemIcon>
                  <CheckIcon fontSize="small" />
                </ListItemIcon>
              )}
              <ListItemText
                inset={!active}
                primary={<I18nLabel id={`common.language.${lang}`} />}
              />
            </MenuItem>
          );
        })}
      </Menu>
    </>
  );
};
