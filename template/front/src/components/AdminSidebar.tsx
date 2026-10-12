/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import {
  Box,
  Divider,
  Drawer,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  ListSubheader,
  Toolbar,
  Tooltip
} from '@mui/material';
import { NavLink } from 'react-router-dom';
import { I18nLabel } from '@/modules_shared/common/components/ui/label/I18nLabel';
import { appPlugins } from '@/plugins';
import { useSessionKeys } from '@/modules_shared/common/hooks/useSessionKeys';

interface AdminSidebarProps {
  open: boolean;
  drawerWidth: number;
  collapsedWidth: number;
}

interface MenuSection {
  id: string;
  labelId: string;
  items: Array<{
    id: string;
    labelId: string;
    to: string;
    icon: React.ElementType;
  }>;
}

// Project-specific sections (empty by default, see CLAUDE.md §2 "Admin") + the sections declared
// by the plugins of the linked shared modules.
const projectMenuSections: MenuSection[] = [];
const menuSections: MenuSection[] = [...projectMenuSections, ...appPlugins.flatMap((p) => p.adminMenu ?? [])];

export const AdminSidebar = ({ open, drawerWidth, collapsedWidth }: AdminSidebarProps) => {
  useSessionKeys(['user']);
  const width = open ? drawerWidth : collapsedWidth;
  return (
    <Drawer
      variant="permanent"
      sx={{
        width,
        flexShrink: 0,
        '& .MuiDrawer-paper': {
          width,
          boxSizing: 'border-box',
          transition: 'width 0.2s ease-in-out'
        }
      }}
      open={open}
    >
      <Toolbar />
      <Divider sx={{ mx: 2, mb: 1 }} />
      <List disablePadding>
        {menuSections.map((section) => (
          <Box key={section.id} component="nav">
            {open ? (
              <ListSubheader disableSticky sx={{ lineHeight: '32px' }}>
                <I18nLabel id={section.labelId} />
              </ListSubheader>
            ) : (
              <Divider sx={{ mx: 2, my: 1 }} />
            )}
            {section.items.map((item) => {
              const Icon = item.icon;
              return (
                <ListItem key={item.id} disablePadding sx={{ display: 'block' }}>
                  <Tooltip title={!open ? <I18nLabel id={item.labelId} /> : ''} placement="right">
                    <ListItemButton
                      component={NavLink}
                      to={item.to}
                      sx={{
                        minHeight: 48,
                        justifyContent: open ? 'initial' : 'center',
                        px: 2.5,
                        '&.active': {
                          bgcolor: 'action.selected'
                        }
                      }}
                    >
                      <ListItemIcon
                        sx={{
                          minWidth: 0,
                          mr: open ? 2 : 'auto',
                          justifyContent: 'center'
                        }}
                      >
                        <Icon fontSize="small" />
                      </ListItemIcon>
                      <ListItemText
                        primary={<I18nLabel id={item.labelId} />}
                        sx={{ opacity: open ? 1 : 0 }}
                      />
                    </ListItemButton>
                  </Tooltip>
                </ListItem>
              );
            })}
          </Box>
        ))}
      </List>
    </Drawer>
  );
};
