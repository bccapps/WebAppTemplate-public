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
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  ListSubheader,
  Toolbar,
  Tooltip,
  useMediaQuery
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import ChevronLeftRoundedIcon from '@mui/icons-material/ChevronLeftRounded';
import ChevronRightRoundedIcon from '@mui/icons-material/ChevronRightRounded';
import { NavLink } from 'react-router-dom';
import { I18nLabel } from '@/modules_shared/common/components/ui/label/I18nLabel';
import { appPlugins } from '@/plugins';
import { appAdminMenu, appNavMenu } from '@/config/navigation';
import { mergeMenuSections, resolveMenu } from '@/modules_shared/common/plugins/menus';
import { useMenuContext } from '@/modules_shared/common/plugins/useMenuContext';
import type { MenuSection, RouteLayout } from '@/modules_shared/common/plugins/AppPlugin';

export const SIDEBAR_WIDTH = 240;
export const SIDEBAR_COLLAPSED_WIDTH = 64;

/** Phones (below the `sm` breakpoint): the sidebar stays a rail and expanding it opens an overlay instead of squeezing the page. */
export function useCompactSidebar(): boolean {
  const theme = useTheme();
  return useMediaQuery(theme.breakpoints.down('sm'), { noSsr: true });
}

interface AppSidebarProps {
  open: boolean;
  onToggle: () => void;
  /** `admin` pages add the admin menu to the navigation menu. */
  layout: Exclude<RouteLayout, 'fullscreen'>;
}

// Entries of the app (config/navigation.ts) first, then those of the plugins; sections sharing an id are merged.
const navSections = mergeMenuSections(appNavMenu, ...appPlugins.map((p) => p.navMenu));
const adminSections = mergeMenuSections(appAdminMenu, ...appPlugins.map((p) => p.adminMenu));

/** Sections shown to the current visitor on a layout; the sidebar is not rendered when this is empty. */
function useSidebarSections(layout: AppSidebarProps['layout']): MenuSection[] {
  const ctx = useMenuContext();
  const nav = resolveMenu(navSections, ctx);
  return layout === 'admin' ? [...nav, ...resolveMenu(adminSections, ctx, { adminOnly: true })] : nav;
}

function SidebarSection({ section, open, onNavigate }: { section: MenuSection; open: boolean; onNavigate?: () => void }) {
  return (
    <Box component="nav">
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
                onClick={onNavigate}
                sx={{
                  minHeight: 48,
                  justifyContent: open ? 'initial' : 'center',
                  px: 2.5,
                  '&.active': { bgcolor: 'action.selected' }
                }}
              >
                <ListItemIcon sx={{ minWidth: 0, mr: open ? 2 : 'auto', justifyContent: 'center' }}>
                  <Icon fontSize="small" />
                </ListItemIcon>
                <ListItemText primary={<I18nLabel id={item.labelId} />} sx={{ opacity: open ? 1 : 0 }} />
              </ListItemButton>
            </Tooltip>
          </ListItem>
        );
      })}
    </Box>
  );
}

interface SidebarBodyProps {
  sections: MenuSection[];
  open: boolean;
  onToggle: () => void;
  onNavigate?: () => void;
}

function SidebarBody({ sections, open, onToggle, onNavigate }: SidebarBodyProps) {
  return (
    <>
      <Toolbar />
      <Divider sx={{ mx: 2, mb: 1 }} />
      <List disablePadding>
        {sections.map((section) => (
          <SidebarSection key={section.id} section={section} open={open} onNavigate={onNavigate} />
        ))}
      </List>
      <Box sx={{ mt: 'auto', display: 'flex', justifyContent: open ? 'flex-end' : 'center', p: 1 }}>
        <Tooltip title={<I18nLabel id={open ? 'common.nav.sidebar.collapse' : 'common.nav.sidebar.expand'} />} placement="right">
          <IconButton size="small" onClick={onToggle}>
            {open ? <ChevronLeftRoundedIcon fontSize="small" /> : <ChevronRightRoundedIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
      </Box>
    </>
  );
}

export const AppSidebar = ({ open, onToggle, layout }: AppSidebarProps) => {
  const sections = useSidebarSections(layout);
  const compact = useCompactSidebar();
  if (sections.length === 0) return null;
  // The column that takes room in the page: never wider than the rail on a phone (the overlay below covers the page instead).
  const columnOpen = open && !compact;
  const width = columnOpen ? SIDEBAR_WIDTH : SIDEBAR_COLLAPSED_WIDTH;
  return (
    <>
      <Drawer
        variant="permanent"
        sx={{
          width,
          flexShrink: 0,
          '& .MuiDrawer-paper': { width, boxSizing: 'border-box', transition: 'width 0.2s ease-in-out' }
        }}
        open={columnOpen}
      >
        <SidebarBody sections={sections} open={columnOpen} onToggle={onToggle} />
      </Drawer>
      {compact && (
        <Drawer
          variant="temporary"
          className="mobile-drawer"
          open={open}
          onClose={onToggle}
          sx={{ '& .MuiDrawer-paper': { width: SIDEBAR_WIDTH, maxWidth: '85vw', boxSizing: 'border-box' } }}
        >
          <SidebarBody sections={sections} open onToggle={onToggle} onNavigate={onToggle} />
        </Drawer>
      )}
    </>
  );
};
