/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useCallback, useState, type ChangeEvent } from 'react';
import { Box, Button, CircularProgress, DialogActions, Stack, TextField, Typography } from '@mui/material';
import { I18nLabel } from '../../common/components/ui/label/I18nLabel';
import { ToastZone } from '../../common/components/ui/toast/ToastZone';
import { i18n } from '../../common/core/i18n/I18n';
import { issueReportApi } from '../services/IssueReportApi';
import {
  currentPageUrl,
  errorMessageKey,
  ISSUE_REPORT_DESCRIPTION_MAX,
  ISSUE_REPORT_TITLE_MAX,
  validateIssueReportForm,
  type FieldError,
  type IssueReportFormErrors,
} from '../utils/issueReportForm';
import '../styles/tokens.css';

export interface IssueReportFormProps {
  submitting: boolean;
  onSubmittingChange: (submitting: boolean) => void;
  /** Called with the hub number once the report is accepted. */
  onSent: (number: number) => void;
  onCancel: () => void;
}

const hintSx = { color: 'var(--issue-report-form-hint-fg)' };

function helperOf(error: FieldError | undefined, length: number, max: number): string {
  return error ? i18n.get(error.key, error.params) : i18n.get('issueReport.form.counter', [length, max]);
}

/** Title + description; required fields marked, errors on submit, fields locked while sending. */
export function IssueReportForm({ submitting, onSubmittingChange, onSent, onCancel }: IssueReportFormProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [errors, setErrors] = useState<IssueReportFormErrors>({});

  const handleTitle = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setTitle(event.target.value);
    setErrors((previous) => ({ ...previous, title: undefined }));
  }, []);

  const handleDescription = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setDescription(event.target.value);
    setErrors((previous) => ({ ...previous, description: undefined }));
  }, []);

  const handleSubmit = useCallback(() => {
    const found = validateIssueReportForm(title, description);
    setErrors(found);
    if (found.title || found.description) return;
    onSubmittingChange(true);
    issueReportApi
      .create({ title: title.trim(), description: description.trim(), pageUrl: currentPageUrl() })
      .then(({ number }) => {
        onSubmittingChange(false);
        ToastZone.addMessage('issueReport.toast.sent.title', 'issueReport.toast.sent.message', 'success', { textParams: [number] });
        onSent(number);
      })
      .catch((error: unknown) => {
        onSubmittingChange(false);
        ToastZone.addMessage('issueReport.toast.error.title', errorMessageKey(error), 'error');
      });
  }, [title, description, onSubmittingChange, onSent]);

  return (
    <>
      <Box sx={{ px: 3, pt: 2, pb: 1 }}>
        <Stack spacing={2}>
          <Typography variant="body2" sx={hintSx}>
            <I18nLabel id="issueReport.form.intro" />
          </Typography>
          <TextField
            label={i18n.get('issueReport.form.title')}
            placeholder={i18n.get('issueReport.form.titlePlaceholder')}
            value={title}
            onChange={handleTitle}
            error={Boolean(errors.title)}
            helperText={helperOf(errors.title, title.trim().length, ISSUE_REPORT_TITLE_MAX)}
            slotProps={{ htmlInput: { maxLength: ISSUE_REPORT_TITLE_MAX } }}
            disabled={submitting}
            required
            fullWidth
            autoFocus
          />
          <TextField
            label={i18n.get('issueReport.form.description')}
            placeholder={i18n.get('issueReport.form.descriptionPlaceholder')}
            value={description}
            onChange={handleDescription}
            error={Boolean(errors.description)}
            helperText={helperOf(errors.description, description.trim().length, ISSUE_REPORT_DESCRIPTION_MAX)}
            slotProps={{ htmlInput: { maxLength: ISSUE_REPORT_DESCRIPTION_MAX } }}
            disabled={submitting}
            required
            fullWidth
            multiline
            minRows={5}
            maxRows={12}
          />
          <Typography variant="caption" sx={hintSx}>
            <I18nLabel id="issueReport.form.pageNote" />
          </Typography>
        </Stack>
      </Box>
      <DialogActions>
        <Button onClick={onCancel} disabled={submitting}>
          <I18nLabel id="issueReport.form.cancel" />
        </Button>
        <Button onClick={handleSubmit} variant="contained" disabled={submitting}>
          {submitting ? <CircularProgress size={16} color="inherit" /> : <I18nLabel id="issueReport.form.submit" />}
        </Button>
      </DialogActions>
    </>
  );
}

export default IssueReportForm;
