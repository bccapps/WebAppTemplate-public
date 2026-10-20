/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import '../../styles/tokens.css';
import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Paper,
  Snackbar,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import BlockIcon from '@mui/icons-material/Block';
import DeleteForeverIcon from '@mui/icons-material/DeleteForever';
import { sessionAuth } from '@/modules_shared/common/auth/sessionAuth';
import { AdminTokenGate } from '@/modules_shared/common/components/ui/admin/AdminTokenGate';
import { themeService, ThemeDto } from '../../services/ThemeService';
import { I18nLabel } from './label/I18nLabel';
import { i18n } from '../../core/i18n/I18n';
import { useSessionKeys } from '@/modules_shared/common/hooks/useSessionKeys';

const AdminThemesContent = () => {
  useSessionKeys(['user']);
  const isAdmin = sessionAuth.isAdmin();

  const [rows, setRows] = useState<ThemeDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; id: string } | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createDescription, setCreateDescription] = useState('');
  const [createNameError, setCreateNameError] = useState(false);
  const [createDescError, setCreateDescError] = useState(false);

  const [deleteDialog, setDeleteDialog] = useState<{ id: number; name: string } | null>(null);

  // Edit CSS dialog
  const [editOpen, setEditOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [editCss, setEditCss] = useState('');
  const [editLoading, setEditLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    themeService
      .adminList()
      .then((data: ThemeDto[]) => {
        setRows(data ?? []);
        setLoading(false);
      })
      .fail(() => {
        setToast({ type: 'error', id: 'common.themes.toast.error' });
        setLoading(false);
      })
      .error(() => {
        setToast({ type: 'error', id: 'common.themes.toast.error' });
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (isAdmin) {
      load();
    }
  }, [isAdmin, load]);

  const handleCreate = () => {
    const nameEmpty = !createName.trim();
    const descEmpty = !createDescription.trim();
    setCreateNameError(nameEmpty);
    setCreateDescError(descEmpty);
    if (nameEmpty || descEmpty) return;

    setSaving(true);
    themeService
      .adminCreate(createName.trim(), createDescription.trim())
      .then(() => {
        setSaving(false);
        setCreateOpen(false);
        setCreateName('');
        setCreateDescription('');
        setCreateNameError(false);
        setCreateDescError(false);
        setToast({ type: 'success', id: 'common.themes.toast.createSuccess' });
        load();
      })
      .fail(() => {
        setSaving(false);
        setToast({ type: 'error', id: 'common.themes.toast.createError' });
      })
      .error(() => {
        setSaving(false);
        setToast({ type: 'error', id: 'common.themes.toast.createError' });
      });
  };

  const handleActivate = (id: number) => {
    setSaving(true);
    themeService
      .adminActivate(id)
      .then(() => {
        setSaving(false);
        setToast({ type: 'success', id: 'common.themes.toast.activateSuccess' });
        load();
      })
      .fail(() => {
        setSaving(false);
        setToast({ type: 'error', id: 'common.themes.toast.error' });
      })
      .error(() => {
        setSaving(false);
        setToast({ type: 'error', id: 'common.themes.toast.error' });
      });
  };

  const handleDeactivate = (id: number) => {
    setSaving(true);
    themeService
      .adminDeactivate(id)
      .then(() => {
        setSaving(false);
        setToast({ type: 'success', id: 'common.themes.toast.deactivateSuccess' });
        load();
      })
      .fail(() => {
        setSaving(false);
        setToast({ type: 'error', id: 'common.themes.toast.error' });
      })
      .error(() => {
        setSaving(false);
        setToast({ type: 'error', id: 'common.themes.toast.error' });
      });
  };

  const handleDelete = (id: number) => {
    setSaving(true);
    themeService
      .adminDelete(id)
      .then(() => {
        setSaving(false);
        setDeleteDialog(null);
        setToast({ type: 'success', id: 'common.themes.toast.deleteSuccess' });
        load();
      })
      .fail(() => {
        setSaving(false);
        setToast({ type: 'error', id: 'common.themes.toast.error' });
      })
      .error(() => {
        setSaving(false);
        setToast({ type: 'error', id: 'common.themes.toast.error' });
      });
  };

  const openEdit = (row: ThemeDto) => {
    setEditId(row.id);
    setEditName(row.name);
    setEditCss('');
    setEditLoading(true);
    setEditOpen(true);
    themeService
      .adminGet(row.id)
      .then((data: any) => {
        setEditCss(data?.css ?? '');
        setEditLoading(false);
      })
      .fail(() => {
        setEditLoading(false);
        setToast({ type: 'error', id: 'common.themes.toast.error' });
      })
      .error(() => {
        setEditLoading(false);
        setToast({ type: 'error', id: 'common.themes.toast.error' });
      });
  };

  const handleSaveCss = () => {
    if (editId == null) return;
    setSaving(true);
    themeService
      .adminUpdateCss(editId, editCss)
      .then(() => {
        setSaving(false);
        setEditOpen(false);
        setToast({ type: 'success', id: 'common.themes.toast.editSuccess' });
        load();
      })
      .fail(() => {
        setSaving(false);
        setToast({ type: 'error', id: 'common.themes.toast.error' });
      })
      .error(() => {
        setSaving(false);
        setToast({ type: 'error', id: 'common.themes.toast.error' });
      });
  };

  const getStatusChip = (row: ThemeDto) => {
    if (row.isDefault) {
      return <Chip size="small" label={<I18nLabel id="common.themes.default" />} color="success" />;
    }
    if (row.active) {
      return <Chip size="small" label={<I18nLabel id="common.themes.active" />} color="success" />;
    }
    return <Chip size="small" label={<I18nLabel id="common.themes.inactive" />} color="warning" />;
  };

  return (
    <Box>
      <Stack
        direction="row"
        sx={{
          alignItems: "center",
          justifyContent: "space-between",
          mb: 2
        }}>
        <Typography variant="h5">
          <I18nLabel id="common.themes.title" />
        </Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => setCreateOpen(true)}>
          <I18nLabel id="common.themes.create" />
        </Button>
      </Stack>
      <Box sx={{ position: 'relative' }}>
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={{ width: 1, whiteSpace: 'nowrap' }}>ID</TableCell>
                <TableCell><I18nLabel id="common.themes.name" /></TableCell>
                <TableCell><I18nLabel id="common.themes.code" /></TableCell>
                <TableCell><I18nLabel id="common.themes.description" /></TableCell>
                <TableCell><I18nLabel id="common.themes.status" /></TableCell>
                <TableCell align="right"><I18nLabel id="common.actions" /></TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.length === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={6} align="center">
                    <Typography variant="body2" sx={{
                      color: "text.secondary"
                    }}>
                      <I18nLabel id="common.themes.empty" />
                    </Typography>
                  </TableCell>
                </TableRow>
              )}
              {rows.map((row: ThemeDto) => (
                <TableRow key={row.id}>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{row.id}</TableCell>
                  <TableCell>{row.name}</TableCell>
                  <TableCell>
                    <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                      {row.code}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Typography
                      variant="body2"
                      sx={{
                        maxWidth: 250,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {row.description || '-'}
                    </Typography>
                  </TableCell>
                  <TableCell>{getStatusChip(row)}</TableCell>
                  <TableCell align="right">
                    {!row.isDefault && row.hasCss && (
                      <Button
                        size="small"
                        startIcon={<EditIcon />}
                        onClick={() => openEdit(row)}
                        disabled={saving}
                      >
                        <I18nLabel id="common.themes.editCss" />
                      </Button>
                    )}
                    {!row.isDefault && row.active && (
                      <Button
                        size="small"
                        startIcon={<BlockIcon />}
                        onClick={() => handleDeactivate(row.id)}
                        disabled={saving}
                      >
                        <I18nLabel id="common.themes.deactivate" />
                      </Button>
                    )}
                    {!row.isDefault && !row.active && (
                      <Button
                        size="small"
                        startIcon={<CheckCircleIcon />}
                        onClick={() => handleActivate(row.id)}
                        disabled={saving}
                        color="success"
                      >
                        <I18nLabel id="common.themes.activate" />
                      </Button>
                    )}
                    {!row.isDefault && (
                      <Button
                        size="small"
                        startIcon={<DeleteForeverIcon />}
                        onClick={() => setDeleteDialog({ id: row.id, name: row.name })}
                        disabled={saving}
                        color="error"
                      >
                        <I18nLabel id="common.delete" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
        {loading && (
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'var(--common-adminthemes-scrim)',
            }}
          >
            <CircularProgress />
          </Box>
        )}
      </Box>
      {/* Create theme dialog */}
      <Dialog
        open={createOpen}
        onClose={() => {
          if (!saving) setCreateOpen(false);
        }}
        maxWidth="sm"
        fullWidth
        slotProps={{ backdrop: { sx: { backdropFilter: 'blur(4px)' } } }}
      >
        <DialogTitle>
          <I18nLabel id="common.themes.createTitle" />
        </DialogTitle>
        <DialogContent dividers>
          <TextField
            label={<I18nLabel id="common.themes.name" />}
            value={createName}
            onChange={(e) => {
              setCreateName(e.target.value);
              if (e.target.value.trim()) setCreateNameError(false);
            }}
            fullWidth
            required
            disabled={saving}
            error={createNameError}
            helperText={createNameError ? i18n.get('common.form.required') : undefined}
            sx={{ mt: 1, mb: 2 }}
          />
          <TextField
            label={<I18nLabel id="common.themes.description" />}
            helperText={
              createDescError
                ? i18n.get('common.form.required')
                : i18n.get('common.themes.descriptionHint')
            }
            value={createDescription}
            onChange={(e) => {
              setCreateDescription(e.target.value);
              if (e.target.value.trim()) setCreateDescError(false);
            }}
            fullWidth
            required
            multiline
            rows={3}
            disabled={saving}
            error={createDescError}
          />
          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
              mt: 2
            }}>
            <I18nLabel id="common.themes.generating" />
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)} disabled={saving}>
            <I18nLabel id="common.cancel" />
          </Button>
          <Button onClick={handleCreate} variant="contained" disabled={saving}>
            {saving ? <CircularProgress size={16} /> : <I18nLabel id="common.themes.generate" />}
          </Button>
        </DialogActions>
      </Dialog>
      {/* Delete confirmation dialog */}
      <Dialog
        open={deleteDialog !== null}
        onClose={() => {
          if (!saving) setDeleteDialog(null);
        }}
        slotProps={{ backdrop: { sx: { backdropFilter: 'blur(4px)' } } }}
      >
        <DialogTitle sx={{ color: 'error.main' }}>
          <I18nLabel id="common.themes.deleteConfirm" />
        </DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            <I18nLabel id="common.themes.deleteWarning" />
          </Typography>
          <Box sx={{ mt: 1, p: 1, bgcolor: 'action.hover', borderRadius: 1 }}>
            <Typography variant="body2" sx={{ fontWeight: 700 }}>
              {deleteDialog?.name}
            </Typography>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteDialog(null)} disabled={saving}>
            <I18nLabel id="common.cancel" />
          </Button>
          <Button
            onClick={() => deleteDialog && handleDelete(deleteDialog.id)}
            variant="contained"
            color="error"
            disabled={saving}
          >
            {saving ? <CircularProgress size={16} /> : <I18nLabel id="common.delete" />}
          </Button>
        </DialogActions>
      </Dialog>
      {/* Edit CSS dialog */}
      <Dialog
        open={editOpen}
        onClose={() => { if (!saving) setEditOpen(false); }}
        maxWidth="lg"
        fullWidth
        slotProps={{ backdrop: { sx: { backdropFilter: 'blur(4px)' } } }}
      >
        <DialogTitle>
          <I18nLabel id="common.themes.editCssTitle" /> — {editName}
        </DialogTitle>
        <DialogContent dividers>
          {editLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
              <CircularProgress />
            </Box>
          ) : (
            <TextField
              multiline
              fullWidth
              minRows={20}
              maxRows={40}
              value={editCss}
              onChange={(e) => setEditCss(e.target.value)}
              disabled={saving}
              slotProps={{
                htmlInput: {
                  style: {
                    fontFamily: 'monospace',
                    fontSize: '0.8rem',
                    lineHeight: 1.5,
                    tabSize: 2,
                    whiteSpace: 'pre',
                    overflowWrap: 'normal',
                    overflowX: 'auto',
                  },
                },
              }}
              sx={{
                '& .MuiInputBase-root': {
                  bgcolor: 'var(--common-adminthemes-field-bg)',
                  borderRadius: 1,
                },
              }}
            />
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditOpen(false)} disabled={saving}>
            <I18nLabel id="common.cancel" />
          </Button>
          <Button onClick={handleSaveCss} variant="contained" disabled={saving || editLoading}>
            {saving ? <CircularProgress size={16} /> : <I18nLabel id="common.save" />}
          </Button>
        </DialogActions>
      </Dialog>
      <Snackbar
        open={Boolean(toast)}
        autoHideDuration={4000}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        {toast ? (
          <Alert severity={toast.type} variant="filled" onClose={() => setToast(null)}>
            <I18nLabel id={toast.id} />
          </Alert>
        ) : undefined}
      </Snackbar>
    </Box>
  );
};

const unauthorizedNotice = (
  <Box sx={{ p: 4 }}>
    <Typography color="error">
      <I18nLabel id="common.unauthorized" />
    </Typography>
  </Box>
);

const AdminThemes = () => (
  <AdminTokenGate unauthorized={unauthorizedNotice}>
    <AdminThemesContent />
  </AdminTokenGate>
);

export default AdminThemes;
