/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import React from 'react';
import { Box, Button, CircularProgress, Stack, TextField, Typography } from '@mui/material';
import { I18nLabel } from '../label/I18nLabel';
import Unauthorized from '../unauthorized/Unauthorized';
import { adminTokenAuth } from '../../../auth/adminTokenAuth';
import { detectLocalTrust, sessionAuth } from '../../../auth/sessionAuth';
import { useSessionKeys } from '../../../hooks/useSessionKeys';
import { i18n } from '../../../core/i18n/I18n';

export interface AdminTokenGateProps {
  children: React.ReactNode;
  /** Rendered when user management is active and the user is not an admin (default: `<Unauthorized />`). */
  unauthorized?: React.ReactNode;
}

const AdminKeyForm: React.FC = () => {
  const [token, setToken] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<'required' | 'invalid' | null>(null);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    if (token.trim().length === 0) {
      setError('required');
      return;
    }
    setError(null);
    setSubmitting(true);
    const ok = await adminTokenAuth.login(token.trim());
    if (!ok) {
      setSubmitting(false);
      setError('invalid');
    }
  };

  const helper =
    error === 'required' ? i18n.get('common.form.required') : error === 'invalid' ? i18n.get('common.admin.tokenGate.invalid') : undefined;

  return (
    <Box component="form" onSubmit={handleSubmit} noValidate sx={{ maxWidth: 420, mx: 'auto', mt: 8, p: 2 }}>
      <Stack spacing={2}>
        <Typography variant="h6">
          <I18nLabel id="common.admin.tokenGate.title" />
        </Typography>
        <TextField
          type="password"
          autoComplete="off"
          label={i18n.get('common.admin.tokenGate.label')}
          value={token}
          onChange={(e) => {
            setToken(e.target.value);
            if (error) setError(null);
          }}
          error={error !== null}
          helperText={helper}
          disabled={submitting}
          required
          autoFocus
        />
        <Button type="submit" variant="contained" disabled={submitting}>
          {submitting ? <CircularProgress size={16} color="inherit" /> : <I18nLabel id="common.admin.tokenGate.submit" />}
        </Button>
      </Stack>
    </Box>
  );
};

/**
 * Guards admin pages. Renders `children` for admins; in anonymous mode (no user module) asks for the admin key
 * once (kept in sessionStorage), except in local trust mode (`LOCAL_TRUST`, no key needed); with user management it keeps the historical "unauthorized" behaviour.
 */
export const AdminTokenGate: React.FC<AdminTokenGateProps> = ({ children, unauthorized }) => {
  useSessionKeys(['user']);
  const anonymous = sessionAuth.mode === 'anonymous';
  const [checked, setChecked] = React.useState(!anonymous);
  React.useEffect(() => {
    if (!anonymous) return;
    let live = true;
    void detectLocalTrust().finally(() => live && setChecked(true));
    return () => {
      live = false;
    };
  }, [anonymous]);
  if (sessionAuth.isAdmin()) return <>{children}</>;
  if (anonymous) return checked ? <AdminKeyForm /> : null; // wait for the local trust check: no flash of the key form
  return <>{unauthorized ?? <Unauthorized />}</>;
};

export default AdminTokenGate;
