/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import React from 'react';
import {
  Box,
  Typography,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Chip,
  IconButton,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  CircularProgress,
  Alert,
} from '@mui/material';
import EditIcon from '@mui/icons-material/Edit';
import { i18n } from '@/modules_shared/common/core/i18n/I18n';
import { httpService } from '@/modules_shared/common/core/http/HttpService';
import { configurationService } from '@/modules_shared/common/services/ConfigurationService';

interface ModuleUrlEntry {
  name: string;
  value: string;
  description?: string;
}

const isRemote = (url: string): boolean => url.startsWith('https://');

const moduleLabel = (name: string): string => name.replace(/^api_url_/, '');

const AdminModules: React.FC = () => {
  const [entries, setEntries] = React.useState<ModuleUrlEntry[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const [editEntry, setEditEntry] = React.useState<ModuleUrlEntry | null>(null);
  const [editValue, setEditValue] = React.useState('');
  const [editError, setEditError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [saveSuccess, setSaveSuccess] = React.useState(false);

  const fetchEntries = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await new Promise<void>((resolve, reject) => {
        httpService
          .get(configurationService.getApiUrl() + '/admin/configurations/module-urls')
          .then((data: ModuleUrlEntry[]) => {
            setEntries(Array.isArray(data) ? data : []);
            resolve();
          })
          .fail(reject)
          .error(reject)
          .notAuthorized(reject);
      });
    } catch {
      setError(i18n.get('common.error.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    fetchEntries();
  }, [fetchEntries]);

  const handleEdit = React.useCallback((entry: ModuleUrlEntry) => {
    setEditEntry(entry);
    setEditValue(entry.value);
    setEditError(null);
    setSaveSuccess(false);
  }, []);

  const handleClose = React.useCallback(() => {
    if (saving) return;
    setEditEntry(null);
  }, [saving]);

  const handleSave = React.useCallback(async () => {
    if (!editEntry) return;
    const trimmed = editValue.trim();
    if (!trimmed) {
      setEditError(i18n.get('admin.modules.urlRequired'));
      return;
    }
    setSaving(true);
    setEditError(null);
    try {
      await new Promise<void>((resolve, reject) => {
        httpService
          .put(configurationService.getApiUrl() + '/configurations', [
            { name: editEntry.name, value: trimmed, description: editEntry.description },
          ])
          .then(() => resolve())
          .fail(reject)
          .error(reject)
          .notAuthorized(reject);
      });
      setSaveSuccess(true);
      setEntries((prev) =>
        prev.map((e) => (e.name === editEntry.name ? { ...e, value: trimmed } : e)),
      );
      setTimeout(() => setEditEntry(null), 800);
    } catch {
      setEditError(i18n.get('admin.modules.saveError'));
    } finally {
      setSaving(false);
    }
  }, [editEntry, editValue]);

  return (
    <Box>
      <Typography variant="h6" gutterBottom>
        {i18n.get('admin.modules.title')}
      </Typography>
      <Typography
        variant="body2"
        sx={{
          color: "text.secondary",
          mb: 2
        }}>
        {i18n.get('admin.modules.subtitle')}
      </Typography>
      {loading && (
        <Box
          sx={{
            display: "flex",
            justifyContent: "center",
            py: 4
          }}>
          <CircularProgress size={32} />
        </Box>
      )}
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {!loading && !error && (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{i18n.get('admin.modules.colModule')}</TableCell>
                <TableCell>{i18n.get('admin.modules.colUrl')}</TableCell>
                <TableCell>{i18n.get('common.themes.status')}</TableCell>
                <TableCell align="right" />
              </TableRow>
            </TableHead>
            <TableBody>
              {entries.map((entry) => (
                <TableRow key={entry.name} hover>
                  <TableCell>
                    <Typography variant="body2" sx={{
                      fontWeight: 500
                    }}>
                      {moduleLabel(entry.name)}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
                      {entry.value}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Chip
                      label={i18n.get(isRemote(entry.value) ? 'admin.modules.statusRemote' : 'admin.modules.statusLocal')}
                      color={isRemote(entry.value) ? 'primary' : 'default'}
                      size="small"
                    />
                  </TableCell>
                  <TableCell align="right">
                    <IconButton size="small" onClick={() => handleEdit(entry)}>
                      <EditIcon fontSize="small" />
                    </IconButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      <Dialog open={!!editEntry} onClose={handleClose} fullWidth maxWidth="sm"
        slotProps={{ backdrop: { sx: { backdropFilter: 'blur(4px)' } } }}>
        <DialogTitle>
          {i18n.get('admin.modules.editTitle')}{editEntry ? moduleLabel(editEntry.name) : ''}
        </DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            label={i18n.get('admin.modules.fieldUrl')}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            disabled={saving}
            error={!!editError}
            helperText={editError ?? editEntry?.description}
            required
            margin="normal"
          />
          {saveSuccess && (
            <Alert severity="success" sx={{ mt: 1 }}>{i18n.get('admin.modules.saveSuccess')}</Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={handleClose} disabled={saving}>
            {i18n.get('common.cancel')}
          </Button>
          <Button variant="contained" onClick={handleSave} disabled={saving}>
            {saving ? <CircularProgress size={18} /> : i18n.get('common.save')}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default AdminModules;
