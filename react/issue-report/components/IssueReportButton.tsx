/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useCallback, useState } from 'react';
import { IconButton, Tooltip } from '@mui/material';
import BugReportOutlinedIcon from '@mui/icons-material/BugReportOutlined';
import { isUserManagementEnabled, sessionAuth } from '../../common/auth/sessionAuth';
import { I18nLabel } from '../../common/components/ui/label/I18nLabel';
import { i18n } from '../../common/core/i18n/I18n';
import { useSessionKeys } from '../../common/hooks/useSessionKeys';
import { useIssueReportEnabled } from '../hooks/useIssueReportEnabled';
import { IssueReportDialog } from './IssueReportDialog';
import '../styles/tokens.css';

export interface IssueReportButtonProps {
  /** Given by `PluginHeaderActions`; when absent the session is read directly. */
  isAuth?: boolean;
}

/**
 * Header button « Report a problem »: shown only to a signed-in user of an app with accounts (`user` module, not the
 * admin key nor local trust) and when the back says `enabled`. Opens `IssueReportDialog`. Usable anywhere (the plugin
 * puts it in the header; an app that hides it there with `headerAction: false` can place it itself).
 */
export function IssueReportButton({ isAuth }: IssueReportButtonProps) {
  useSessionKeys(['user']);
  const signedIn = (isAuth ?? sessionAuth.isAuth()) && isUserManagementEnabled();
  const enabled = useIssueReportEnabled(signedIn);
  const [open, setOpen] = useState(false);
  const handleOpen = useCallback(() => setOpen(true), []);
  const handleClose = useCallback(() => setOpen(false), []);

  if (!enabled) return null;
  return (
    <>
      <Tooltip title={<I18nLabel id="issueReport.button" />}>
        <IconButton
          color="inherit"
          onClick={handleOpen}
          aria-label={i18n.get('issueReport.button')}
          sx={{ background: 'var(--issue-report-button-bg)', borderRadius: '14px' }}
        >
          <BugReportOutlinedIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      {open ? <IssueReportDialog open onClose={handleClose} /> : null}
    </>
  );
}

export default IssueReportButton;
