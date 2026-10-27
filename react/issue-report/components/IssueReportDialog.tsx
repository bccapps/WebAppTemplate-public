/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useCallback, useState, type SyntheticEvent } from 'react';
import { Dialog, DialogActions, DialogTitle, Button, Tab, Tabs } from '@mui/material';
import { I18nLabel } from '../../common/components/ui/label/I18nLabel';
import { i18n } from '../../common/core/i18n/I18n';
import { IssueReportForm } from './IssueReportForm';
import { MyIssueReports } from './MyIssueReports';

export type IssueReportTab = 'new' | 'mine';

export interface IssueReportDialogProps {
  open: boolean;
  onClose: () => void;
  /** Tab shown first (default `new`). */
  initialTab?: IssueReportTab;
}

/** « Report a problem » dialog: the form and the user's own reports, in two tabs. Cannot close while sending. */
export function IssueReportDialog({ open, onClose, initialTab = 'new' }: IssueReportDialogProps) {
  const [tab, setTab] = useState<IssueReportTab>(initialTab);
  const [submitting, setSubmitting] = useState(false);

  const handleClose = useCallback(() => {
    if (!submitting) onClose();
  }, [submitting, onClose]);

  const handleTab = useCallback(
    (_event: SyntheticEvent, value: IssueReportTab) => {
      if (!submitting) setTab(value);
    },
    [submitting],
  );

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="sm"
      fullWidth
      aria-labelledby="issue-report-dialog-title"
      slotProps={{ backdrop: { sx: { backdropFilter: 'blur(4px)' } } }}
    >
      <DialogTitle id="issue-report-dialog-title">
        <I18nLabel id="issueReport.dialog.title" />
      </DialogTitle>
      <Tabs value={tab} onChange={handleTab} variant="fullWidth" sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <Tab value="new" label={i18n.get('issueReport.tab.new')} disabled={submitting} />
        <Tab value="mine" label={i18n.get('issueReport.tab.mine')} disabled={submitting} />
      </Tabs>
      {tab === 'new' ? (
        <IssueReportForm submitting={submitting} onSubmittingChange={setSubmitting} onSent={onClose} onCancel={handleClose} />
      ) : (
        <>
          <MyIssueReports />
          <DialogActions>
            <Button onClick={handleClose}>
              <I18nLabel id="issueReport.dialog.close" />
            </Button>
          </DialogActions>
        </>
      )}
    </Dialog>
  );
}

export default IssueReportDialog;
