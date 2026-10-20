/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import '../../styles/tokens.css';
import {
  Box,
  Card,
  CardActionArea,
  Chip,
  Divider,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import { i18n } from '../../core/i18n/I18n'
import { I18nLabel } from '../../components/ui/label/I18nLabel'
import { useVisualTheme } from '../hooks/useVisualTheme'
import type { ThemeDefinition } from '../types'

/** Theme preview card. */
function ThemeCard({
  theme,
  isActive,
  onSelect,
}: {
  theme: ThemeDefinition
  isActive: boolean
  onSelect: () => void
}) {
  const shellLabel: Record<string, string> = {
    standard: i18n.get('common.theme.shell.standard') || 'Standard',
    terminal: i18n.get('common.theme.shell.terminal') || 'Terminal',
    amstrad: i18n.get('common.theme.shell.amstrad') || 'Amstrad',
  }
  const interactionLabel: Record<string, string> = {
    standard: i18n.get('common.theme.interaction.standard') || 'Menus',
    cli: i18n.get('common.theme.interaction.cli') || 'CLI',
    basic: i18n.get('common.theme.interaction.basic') || 'BASIC',
  }

  const name = theme.name.startsWith('common.') ? i18n.get(theme.name) || theme.id : theme.name
  const description = theme.description
    ? theme.description.startsWith('common.')
      ? i18n.get(theme.description)
      : theme.description
    : undefined

  return (
    <Tooltip title={description ?? ''} placement="top">
      <Card
        variant="outlined"
        sx={{
          border: isActive ? '2px solid' : '1px solid',
          borderColor: isActive ? 'primary.main' : 'divider',
          transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
          boxShadow: isActive ? '0 0 0 3px var(--common-useradminthemes-active-ring)' : 'none',
          position: 'relative',
        }}
      >
        <CardActionArea onClick={onSelect} sx={{ p: 1.75 }}>
          {isActive && (
            <CheckCircleIcon
              sx={{
                position: 'absolute',
                top: 8,
                right: 8,
                color: 'primary.main',
                fontSize: 20,
              }}
            />
          )}
          <Typography variant="subtitle2" sx={{ mb: 0.5, fontWeight: 700 }}>
            {name}
          </Typography>
          {description && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1, lineHeight: 1.4 }}>
              {description}
            </Typography>
          )}
          <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
            <Chip
              label={shellLabel[theme.shell] ?? theme.shell}
              size="small"
              variant="outlined"
              sx={{ fontSize: '0.65rem', height: 20 }}
            />
            <Chip
              label={interactionLabel[theme.interaction] ?? theme.interaction}
              size="small"
              variant="outlined"
              color={theme.interaction !== 'standard' ? 'primary' : 'default'}
              sx={{ fontSize: '0.65rem', height: 20 }}
            />
          </Stack>
        </CardActionArea>
      </Card>
    </Tooltip>
  )
}

/**
 * UserAdminThemes — user-facing theme picker.
 *
 * Returns null when `common_themes_enabled` config key is false.
 *
 * Place inside a UserAdminPage section or user settings panel:
 * ```tsx
 * import { UserAdminThemes } from '@/modules_shared/common/theme/components/UserAdminThemes'
 * <UserAdminThemes />
 * ```
 */
export function UserAdminThemes() {
  const { activeTheme, availableThemes, setTheme, isEnabled } = useVisualTheme()

  if (!isEnabled) return null

  const builtIn = availableThemes.filter((t) => t.builtIn)
  const custom = availableThemes.filter((t) => !t.builtIn)

  return (
    <Box>
      <Typography variant="h6" gutterBottom sx={{ fontWeight: 700 }}>
        <I18nLabel id="common.theme.sectionTitle" />
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        <I18nLabel id="common.theme.sectionSubtitle" />
      </Typography>

      {/* Built-in themes */}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
          gap: 1.5,
          mb: custom.length > 0 ? 3 : 0,
        }}
      >
        {builtIn.map((theme) => (
          <ThemeCard
            key={theme.id}
            theme={theme}
            isActive={activeTheme.id === theme.id}
            onSelect={() => setTheme(theme.id)}
          />
        ))}
      </Box>

      {custom.length > 0 && (
        <>
          <Divider sx={{ my: 2 }}>
            <Typography variant="caption" color="text.secondary">
              <I18nLabel id="common.theme.customSection" />
            </Typography>
          </Divider>
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
              gap: 1.5,
            }}
          >
            {custom.map((theme) => (
              <ThemeCard
                key={theme.id}
                theme={theme}
                isActive={activeTheme.id === theme.id}
                onSelect={() => setTheme(theme.id)}
              />
            ))}
          </Box>
        </>
      )}
    </Box>
  )
}
