/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */


import '../../../styles/tokens.css';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Box, Dialog, Typography } from '@mui/material';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import CloseIcon from '@mui/icons-material/Close';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { i18n } from '../../../core/i18n/I18n';
import { useI18nVersion } from '../../../hooks/useI18nVersion';
import { TipIconButton } from '../iconbutton/TipIconButton';
import { clampIndex, counterText, lightboxKeyAction, stepIndex } from './lightboxNav';

export interface LightboxItem {
  id: string;
  type: 'image' | 'video';
  url: string;
  /** Small image for the thumbnail strip and the video poster. */
  thumbUrl?: string;
  /** Accessible description of an image. */
  alt?: string;
  /** Text under the media (already translated). */
  caption?: ReactNode;
}

export interface LightboxProps {
  items: LightboxItem[];
  /** Index of the displayed item (controlled). */
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  /** Extra buttons in the top bar, before "Close" (the caller owns the behavior). */
  actions?: ReactNode | ((item: LightboxItem, index: number) => ReactNode);
  /** Side panel content (details); a toggle button shows when provided. */
  sidePanel?: (item: LightboxItem, index: number) => ReactNode;
  /** Side panel visible at first. */
  sidePanelOpen?: boolean;
  /** Thumbnail strip under the media when there are several items (default true). */
  thumbnails?: boolean;
}

const isEditable = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]') !== null;

/** Full-screen viewer for images and videos: ←/→ to navigate, Esc to close, click an image to zoom. */
export function Lightbox({ items, index, onIndexChange, onClose, actions, sidePanel, sidePanelOpen = true, thumbnails = true }: LightboxProps) {
  useI18nVersion();
  const [panel, setPanel] = useState(sidePanelOpen);
  const [zoom, setZoom] = useState(false);
  const current = clampIndex(index, items.length);
  const item = items[current];

  useEffect(() => setZoom(false), [current]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = lightboxKeyAction(e.key);
      if (!action || isEditable(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = stepIndex(current, items.length, action);
      if (target !== null) onIndexChange(target);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, items.length, onIndexChange]);

  if (!item) return null;
  const extra = typeof actions === 'function' ? actions(item, current) : actions;
  const previous = stepIndex(current, items.length, 'previous');
  const next = stepIndex(current, items.length, 'next');

  return (
    <Dialog
      open
      fullScreen
      onClose={onClose}
      aria-label={i18n.get('common.ui.media.lightbox.title')}
      slotProps={{ paper: { sx: { bgcolor: 'var(--common-lightbox-paper-bg)', color: 'var(--common-lightbox-paper-fg)', backgroundImage: 'none', flexDirection: 'row' } } }}
    >
      <Box sx={{ position: 'relative', display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, height: 56, px: 2, flexShrink: 0 }}>
          <Typography variant="caption" sx={{ fontFamily: 'monospace', opacity: 0.6 }} aria-live="polite">
            {counterText(current, items.length)}
          </Typography>
          <Box sx={{ flex: 1 }} />
          {extra}
          {sidePanel && (
            <TipIconButton
              labelId={panel ? 'common.ui.media.lightbox.hideDetails' : 'common.ui.media.lightbox.showDetails'}
              tone="ghost"
              active={panel}
              onClick={() => setPanel((v) => !v)}
              sx={{ color: 'inherit' }}
            >
              <InfoOutlinedIcon fontSize="small" />
            </TipIconButton>
          )}
          <TipIconButton labelId="common.ui.media.lightbox.close" kbd="Esc" onClick={onClose} sx={{ color: 'inherit' }}>
            <CloseIcon fontSize="small" />
          </TipIconButton>
        </Box>

        <Box
          onClick={(e) => e.target === e.currentTarget && onClose()}
          sx={{ position: 'relative', flex: 1, minHeight: 0, display: zoom ? 'block' : 'grid', placeItems: 'center', overflow: zoom ? 'auto' : 'hidden', px: 8, pb: 2 }}
        >
          <Media key={item.id} item={item} zoom={zoom} onToggleZoom={() => setZoom((z) => !z)} />
          {previous !== null && <NavArrow side="left" onClick={() => onIndexChange(previous)} />}
          {next !== null && <NavArrow side="right" onClick={() => onIndexChange(next)} />}
        </Box>

        {item.caption && (
          <Typography component="div" variant="body2" sx={{ textAlign: 'center', px: 8, pb: 1.5, opacity: 0.85 }}>
            {item.caption}
          </Typography>
        )}
        {thumbnails && items.length > 1 && <Strip items={items} current={current} onSelect={onIndexChange} />}
      </Box>

      {sidePanel && panel && (
        <Box component="aside" sx={{ width: 320, flexShrink: 0, overflowY: 'auto', p: 2.5, borderLeft: '1px solid var(--common-lightbox-aside-border)', bgcolor: 'var(--common-lightbox-aside-bg)' }}>
          {sidePanel(item, current)}
        </Box>
      )}
    </Dialog>
  );
}

function Media({ item, zoom, onToggleZoom }: { item: LightboxItem; zoom: boolean; onToggleZoom: () => void }) {
  const shadow = '0 40px 120px -30px var(--common-lightbox-media-shadow)';
  if (item.type === 'video') {
    return (
      <Box
        component="video"
        src={item.url}
        poster={item.thumbUrl}
        controls
        autoPlay
        loop
        playsInline
        sx={{ maxWidth: '100%', maxHeight: 'calc(100vh - 8rem)', borderRadius: 2, bgcolor: 'var(--common-lightbox-media-bg)', boxShadow: shadow }}
      />
    );
  }
  return (
    <Box
      component="img"
      src={item.url}
      alt={item.alt ?? ''}
      onClick={onToggleZoom}
      sx={
        zoom
          ? { maxWidth: 'none', cursor: 'zoom-out' }
          : { maxWidth: '100%', maxHeight: 'calc(100vh - 8rem)', objectFit: 'contain', borderRadius: 2, cursor: 'zoom-in', boxShadow: shadow }
      }
    />
  );
}

function NavArrow({ side, onClick }: { side: 'left' | 'right'; onClick: () => void }) {
  return (
    <TipIconButton
      labelId={side === 'left' ? 'common.ui.media.lightbox.previous' : 'common.ui.media.lightbox.next'}
      kbd={side === 'left' ? '←' : '→'}
      onClick={onClick}
      sx={{ position: 'absolute', top: '50%', [side]: 12, transform: 'translateY(-50%)', width: 44, height: 44, color: 'inherit', bgcolor: 'var(--common-lightbox-nav-bg)' }}
    >
      {side === 'left' ? <ChevronLeftIcon /> : <ChevronRightIcon />}
    </TipIconButton>
  );
}

function Strip({ items, current, onSelect }: { items: LightboxItem[]; current: number; onSelect: (index: number) => void }) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'center', gap: 0.75, overflowX: 'auto', px: 2, pb: 2, flexShrink: 0 }}>
      {items.map((it, i) => (
        <Box
          key={it.id}
          component="button"
          type="button"
          onClick={() => onSelect(i)}
          aria-label={counterText(i, items.length)}
          aria-current={i === current ? 'true' : undefined}
          sx={(theme) => ({
            width: 48,
            height: 48,
            p: 0,
            flexShrink: 0,
            overflow: 'hidden',
            borderRadius: 1,
            cursor: 'pointer',
            border: 0,
            bgcolor: 'var(--common-lightbox-thumb-bg)',
            outline: `2px solid ${i === current ? theme.palette.primary.main : 'transparent'}`,
            opacity: i === current ? 1 : 0.5,
            '&:hover, &:focus-visible': { opacity: 0.9 },
          })}
        >
          {(it.thumbUrl || it.type === 'image') && (
            <Box component="img" src={it.thumbUrl ?? it.url} alt="" sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
          )}
        </Box>
      ))}
    </Box>
  );
}
