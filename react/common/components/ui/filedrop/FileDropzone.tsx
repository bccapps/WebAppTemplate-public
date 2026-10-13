/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, KeyboardEvent, ReactNode } from 'react';
import { Box, Typography } from '@mui/material';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import { i18n } from '../../../core/i18n/I18n';
import { useI18nVersion } from '../../../hooks/useI18nVersion';
import { dragHasFiles, filterFiles } from './fileFilter';
import type { FileFilterOptions, FileRejection } from './fileFilter';

export interface FileDropzoneProps extends FileFilterOptions {
  onFiles: (files: File[]) => void;
  /** Files that were dropped or picked but filtered out, with the reason. */
  onRejected?: (rejections: FileRejection[]) => void;
  disabled?: boolean;
  /** Replaces the default prompt. */
  children?: ReactNode;
}

/** Drop zone and file picker (click, Enter or Space). The local counterpart of `useWindowDrop`. */
export function FileDropzone({ accept, multiple, maxSizeBytes, onFiles, onRejected, disabled, children }: FileDropzoneProps) {
  useI18nVersion();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [lastReasons, setLastReasons] = useState<string[]>([]);

  const receive = (list: FileList | null) => {
    const { accepted, rejected } = filterFiles(Array.from(list ?? []), { accept, multiple, maxSizeBytes });
    setLastReasons([...new Set(rejected.map((r) => r.reason))].map((reason) => `common.ui.dropzone.reject.${reason}`));
    if (accepted.length > 0) onFiles(accepted);
    if (rejected.length > 0) onRejected?.(rejected);
  };
  const open = () => !disabled && input.current?.click();
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setOver(false);
    if (!disabled) receive(event.dataTransfer.files);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  };
  return (
    <Box
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      onClick={open}
      onKeyDown={onKeyDown}
      onDragOver={(event: DragEvent) => {
        if (!dragHasFiles(event.dataTransfer?.types)) return;
        event.preventDefault();
        event.stopPropagation();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      sx={{
        display: 'grid',
        placeItems: 'center',
        gap: 0.5,
        p: 3,
        textAlign: 'center',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        border: 2,
        borderStyle: 'dashed',
        borderColor: over ? 'primary.main' : 'divider',
        bgcolor: over ? 'action.hover' : 'transparent',
        borderRadius: 3,
        transition: 'border-color 120ms, background-color 120ms',
        '&:focus-visible': { outline: 2, outlineStyle: 'solid', outlineColor: 'primary.main' },
      }}
    >
      <input
        ref={input}
        type="file"
        hidden
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        onClick={(event) => event.stopPropagation()}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          receive(event.target.files);
          event.target.value = '';
        }}
      />
      {children ?? (
        <>
          <UploadFileIcon color="action" aria-hidden />
          <Typography variant="body2" color="text.secondary">
            {i18n.get(over ? 'common.ui.dropzone.release' : multiple ? 'common.ui.dropzone.promptMultiple' : 'common.ui.dropzone.prompt')}
          </Typography>
        </>
      )}
      {lastReasons.map((key) => (
        <Typography key={key} variant="caption" color="error" role="alert">
          {i18n.get(key)}
        </Typography>
      ))}
    </Box>
  );
}
