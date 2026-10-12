/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useState } from 'react';
import {
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
} from '@mui/material';
import { I18nLabel } from './label/I18nLabel';
import { i18n } from '../../core/i18n/I18n';
import { httpService } from '../../core/http/HttpService';
import { configurationService } from '../../services/ConfigurationService';
import { ToastZone } from './toast/ToastZone';
import { sessionAuth } from '../../auth/sessionAuth';

interface BugReportModalProps {
  open: boolean;
  onClose: () => void;
}

const BugReportModal = ({ open, onClose }: BugReportModalProps) => {
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, boolean>>({});

  const validate = () => {
    const next: Record<string, boolean> = {};
    if (!subject.trim()) next.subject = true;
    if (!description.trim()) next.description = true;
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSubmit = () => {
    if (!validate()) return;
    setSubmitting(true);
    const userEmail = sessionAuth.get()?.email ?? '';

    httpService
      .post(configurationService.getApiUrl() + '/common/bug-report', {
        subject: subject.trim(),
        description: description.trim(),
        email: userEmail,
      })
      .then(() => {
        setSubmitting(false);
        ToastZone.addMessage(
          'common.bugReport.success.title',
          'common.bugReport.success.message',
          'success',
        );
        setSubject('');
        setDescription('');
        onClose();
      })
      .fail(() => {
        setSubmitting(false);
        ToastZone.addMessage(
          'common.bugReport.error.title',
          'common.bugReport.error.message',
          'error',
        );
      })
      .error(() => {
        setSubmitting(false);
        ToastZone.addMessage(
          'common.bugReport.error.title',
          'common.bugReport.error.message',
          'error',
        );
      });
  };

  const handleClose = () => {
    if (!submitting) onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="sm"
      fullWidth
      slotProps={{ backdrop: { sx: { backdropFilter: 'blur(4px)' } } }}
    >
      <DialogTitle>
        <I18nLabel id="common.bugReport.title" />
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField
            label={i18n.get('common.bugReport.subject')}
            placeholder={i18n.get('common.bugReport.subjectPlaceholder')}
            value={subject}
            onChange={(e) => {
              setSubject(e.target.value);
              if (errors.subject) setErrors((p) => ({ ...p, subject: false }));
            }}
            error={errors.subject}
            helperText={errors.subject ? i18n.get('common.form.required') : undefined}
            disabled={submitting}
            required
          />
          <TextField
            label={i18n.get('common.bugReport.description')}
            placeholder={i18n.get('common.bugReport.descriptionPlaceholder')}
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
              if (errors.description) setErrors((p) => ({ ...p, description: false }));
            }}
            error={errors.description}
            helperText={errors.description ? i18n.get('common.form.required') : undefined}
            disabled={submitting}
            required
            multiline
            minRows={4}
            maxRows={8}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={submitting}>
          <I18nLabel id="common.cancel" />
        </Button>
        <Button onClick={handleSubmit} variant="contained" disabled={submitting}>
          {submitting ? (
            <CircularProgress size={16} color="inherit" />
          ) : (
            <I18nLabel id="common.bugReport.submit" />
          )}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default BugReportModal;
