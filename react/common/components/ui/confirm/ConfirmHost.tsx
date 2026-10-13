/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useRef, useSyncExternalStore } from 'react';
import { Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle } from '@mui/material';
import { i18n } from '../../../core/i18n/I18n';
import { useI18nVersion } from '../../../hooks/useI18nVersion';
import { confirmQueue } from './confirmQueue';
import type { ConfirmOptions } from './confirmQueue';

/**
 * Renders the pending `confirm()` request. Escape, a click outside and the cancel button answer `false`.
 * Focus: MUI traps it inside the dialog and gives it back to the opener on close; the initial focus is on the
 * confirm button, or on "cancel" when `danger` is set (Enter then never destroys by reflex).
 */
export function ConfirmHost() {
  useI18nVersion();
  const current = useSyncExternalStore(confirmQueue.subscribe, confirmQueue.current);
  // Keeps the last content while the closing transition plays.
  const lastShown = useRef<ConfirmOptions | null>(null);
  if (current) lastShown.current = current;
  const options = current ?? lastShown.current;
  if (!options) return null;
  const answer = (ok: boolean) => confirmQueue.settle(ok);
  return (
    <Dialog open={current !== null} onClose={() => answer(false)} maxWidth="xs" fullWidth>
      <DialogTitle>{i18n.get(options.titleId)}</DialogTitle>
      {options.messageId && (
        <DialogContent>
          <DialogContentText sx={{ whiteSpace: 'pre-line' }}>{i18n.get(options.messageId, options.params)}</DialogContentText>
        </DialogContent>
      )}
      <DialogActions>
        <Button color="inherit" autoFocus={options.danger} onClick={() => answer(false)}>
          {i18n.get(options.cancelLabelId ?? 'common.ui.confirm.cancel')}
        </Button>
        <Button
          variant="contained"
          color={options.danger ? 'error' : 'primary'}
          autoFocus={!options.danger}
          onClick={() => answer(true)}
        >
          {i18n.get(options.confirmLabelId ?? 'common.ui.confirm.confirm')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
