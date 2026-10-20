/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import '../../../common/styles/tokens.css';
import { useCallback, useEffect, useMemo, useState } from 'react';
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
  IconButton,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TableSortLabel,
  TextField,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import RefreshIcon from '@mui/icons-material/Refresh';
import { I18nLabel } from '@/modules_shared/common/components/ui/label/I18nLabel';
import { sessionAuth } from '@/modules_shared/common/auth/sessionAuth';
import { voiceService } from '../../services/VoiceService';
import type { VoiceCapability, VoiceProviderCatalog, VoiceProviderCatalogPayload } from '../../types';
import { useSortableTable, type ColumnAccessor } from '@/modules_shared/common/hooks/useSortableTable';
import { i18n } from '@/modules_shared/common/core/i18n/I18n';

const PROVIDER_TYPES = ['google-cloud', 'aws-polly', 'azure-tts', 'elevenlabs', 'deepgram', 'assemblyai', 'openai', 'gladia'] as const;
const ALL_CAPABILITIES: VoiceCapability[] = ['tts', 'stt', 's2s'];

const CAPABILITY_COLORS: Record<VoiceCapability, 'primary' | 'secondary' | 'success'> = {
  tts: 'primary',
  stt: 'secondary',
  s2s: 'success',
};

const defaultForm: VoiceProviderCatalogPayload = {
  name: '',
  slug: '',
  type: 'google-cloud',
  capabilities: ['tts'],
  baseUrl: '',
  website: '',
  signupUrl: '',
};

type ToastState = { type: 'success' | 'error'; message: string } | null;

const toPromise = <T,>(result: unknown): Promise<T> =>
  new Promise((resolve, reject) => {
    const r = result as any;
    if (typeof r?.then === 'function' && typeof r?.fail === 'function') {
      r.then((v: unknown) => resolve(v as T)).fail(reject).error?.(reject);
    } else if (typeof r?.then === 'function') {
      r.then(resolve).catch(reject);
    } else {
      resolve(r as T);
    }
  });

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const AdminVoiceProviderCatalog = () => {
  const isAdmin = sessionAuth.isAdmin();

  const [items, setItems] = useState<VoiceProviderCatalog[]>([]);
  const [loading, setLoading] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<VoiceProviderCatalogPayload>(defaultForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [editing, setEditing] = useState<VoiceProviderCatalog | null>(null);
  const [toast, setToast] = useState<ToastState>(null);

  type ProvColumn = 'name' | 'slug' | 'type' | 'baseUrl';

  const sortColumns = useMemo<ColumnAccessor<VoiceProviderCatalog, ProvColumn>[]>(() => [
    { key: 'name', accessor: (p: VoiceProviderCatalog) => p.name.toLowerCase() },
    { key: 'slug', accessor: (p: VoiceProviderCatalog) => p.slug.toLowerCase() },
    { key: 'type', accessor: (p: VoiceProviderCatalog) => p.type },
    { key: 'baseUrl', accessor: (p: VoiceProviderCatalog) => p.baseUrl },
  ], []);

  const { sortedItems, sortConfig, handleSort } = useSortableTable(items, sortColumns, { field: 'name', direction: 'asc' });

  const loadProviders = useCallback(() => {
    if (!isAdmin) return;
    setLoading(true);
    toPromise<VoiceProviderCatalog[]>(voiceService.listProviderCatalog())
      .then((res) => setItems(Array.isArray(res) ? res : []))
      .catch(() => {
        setItems([]);
        setToast({ type: 'error', message: 'voice_providerCatalogEmptyState' });
      })
      .finally(() => setLoading(false));
  }, [isAdmin]);

  useEffect(() => {
    loadProviders();
  }, [loadProviders]);

  if (!isAdmin) return null;

  const openCreate = () => {
    setEditing(null);
    setForm(defaultForm);
    setFormError(null);
    setDialogOpen(true);
  };

  const openEdit = (row: VoiceProviderCatalog) => {
    setEditing(row);
    setForm({
      name: row.name,
      slug: row.slug,
      type: row.type,
      capabilities: row.capabilities,
      baseUrl: row.baseUrl,
      website: row.website ?? '',
      signupUrl: row.signupUrl ?? '',
    });
    setFormError(null);
    setDialogOpen(true);
  };

  const closeDialog = () => {
    if (saving) return;
    setDialogOpen(false);
    setSaving(false);
    setFormError(null);
  };

  const handleSave = () => {
    const name = form.name.trim();
    const slug = form.slug.trim();
    const baseUrl = form.baseUrl.trim();
    if (!name || name.length < 2) { setFormError('voice_errorLabelRequired'); return; }
    if (!slug || slug.length < 2) { setFormError('voice_providerSlugField'); return; }
    if (!baseUrl || baseUrl.length < 5) { setFormError('voice_errorBaseUrlRequired'); return; }

    setSaving(true);
    setFormError(null);

    const payload: VoiceProviderCatalogPayload = {
      ...form,
      name,
      slug,
      baseUrl,
      website: form.website?.trim() || null,
      signupUrl: form.signupUrl?.trim() || null,
    };

    const request = editing
      ? voiceService.updateProviderCatalog(editing.id, payload)
      : voiceService.createProviderCatalog(payload);

    toPromise<VoiceProviderCatalog>(request)
      .then(() => {
        setToast({ type: 'success', message: editing ? 'voice_providerCatalogSubmitUpdate' : 'voice_providerCatalogSubmitCreate' });
        setDialogOpen(false);
        setSaving(false);
        loadProviders();
      })
      .catch(() => {
        setFormError('voice_providerCatalogEmptyState');
        setSaving(false);
      });
  };

  const handleDelete = (row: VoiceProviderCatalog) => {
    if (!window.confirm(i18n.get('voice_providerCatalogDeleteConfirm'))) return;
    toPromise(voiceService.removeProviderCatalog(row.id))
      .then(() => {
        setToast({ type: 'success', message: 'voice_providerCatalogSubmitUpdate' });
        loadProviders();
      })
      .catch(() => setToast({ type: 'error', message: 'voice_deleteError' }));
  };

  const updateField = <K extends keyof VoiceProviderCatalogPayload>(key: K, value: VoiceProviderCatalogPayload[K]) => {
    setForm((prev) => {
      const next = { ...prev, [key]: value };
      if (key === 'name' && !editing) {
        next.slug = slugify(value as string);
      }
      return next;
    });
  };

  const toggleCapability = (cap: VoiceCapability) => {
    setForm((prev) => {
      const has = prev.capabilities.includes(cap);
      const next = has
        ? prev.capabilities.filter((c) => c !== cap)
        : [...prev.capabilities, cap];
      return { ...prev, capabilities: next.length > 0 ? next : prev.capabilities };
    });
  };

  return (
    <Box className="page-section" sx={{ p: 3 }}>
      <Stack spacing={3}>
        <Stack
          direction={{ xs: 'column', md: 'row' }}
          spacing={2}
          sx={{
            alignItems: { xs: 'flex-start', md: 'center' },
            justifyContent: "space-between"
          }}>
          <Stack spacing={0.5}>
            <Typography variant="h4" sx={{
              fontWeight: 700
            }}>
              <I18nLabel id="voice_providerCatalogTitle" />
            </Typography>
            <Typography variant="body2" sx={{
              color: "text.secondary"
            }}>
              <I18nLabel id="voice_providerCatalogDescription" />
            </Typography>
          </Stack>
          <Stack direction="row" spacing={1}>
            <Button variant="contained" onClick={openCreate}>
              <I18nLabel id="voice_providerCatalogSubmitCreate" />
            </Button>
          </Stack>
        </Stack>

        {toast && (
          <Alert severity={toast.type} onClose={() => setToast(null)}>
            <I18nLabel id={toast.message} />
          </Alert>
        )}

        <Stack direction="row" sx={{
          justifyContent: "flex-end"
        }}>
          <IconButton onClick={loadProviders} disabled={loading}>
            <RefreshIcon />
          </IconButton>
        </Stack>

        <Box sx={{ position: 'relative', borderRadius: 2, border: '1px solid var(--common-voicecatalog-border)' }}>
          {loading && (
            <Box
              sx={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: 'var(--common-voicecatalog-overlay)',
                zIndex: 1,
              }}
            >
              <CircularProgress size={28} />
            </Box>
          )}
          <Table size="small" sx={{ opacity: loading ? 0.5 : 1 }}>
            <TableHead>
              <TableRow>
                <TableCell sortDirection={sortConfig.field === 'name' ? sortConfig.direction : false}>
                  <TableSortLabel active={sortConfig.field === 'name'} direction={sortConfig.field === 'name' ? sortConfig.direction : 'asc'} onClick={() => handleSort('name')}>
                    <I18nLabel id="admin.features.colName" />
                  </TableSortLabel>
                </TableCell>
                <TableCell sortDirection={sortConfig.field === 'slug' ? sortConfig.direction : false}>
                  <TableSortLabel active={sortConfig.field === 'slug'} direction={sortConfig.field === 'slug' ? sortConfig.direction : 'asc'} onClick={() => handleSort('slug')}>
                    <I18nLabel id="voice_providerSlugField" />
                  </TableSortLabel>
                </TableCell>
                <TableCell sortDirection={sortConfig.field === 'type' ? sortConfig.direction : false}>
                  <TableSortLabel active={sortConfig.field === 'type'} direction={sortConfig.field === 'type' ? sortConfig.direction : 'asc'} onClick={() => handleSort('type')}>
                    <I18nLabel id="common.type" />
                  </TableSortLabel>
                </TableCell>
                <TableCell><I18nLabel id="voice_providerCapabilitiesField" /></TableCell>
                <TableCell sortDirection={sortConfig.field === 'baseUrl' ? sortConfig.direction : false}>
                  <TableSortLabel active={sortConfig.field === 'baseUrl'} direction={sortConfig.field === 'baseUrl' ? sortConfig.direction : 'asc'} onClick={() => handleSort('baseUrl')}>
                    <I18nLabel id="common.baseUrl" />
                  </TableSortLabel>
                </TableCell>
                <TableCell align="right"><I18nLabel id="common.actions" /></TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {sortedItems.map((row) => (
                <TableRow key={row.id} hover>
                  <TableCell>{row.name}</TableCell>
                  <TableCell>
                    <Chip label={row.slug} size="small" variant="outlined" />
                  </TableCell>
                  <TableCell>
                    <Chip label={row.type} size="small" color="primary" variant="outlined" />
                  </TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={0.5}>
                      {row.capabilities.map((cap) => (
                        <Chip
                          key={cap}
                          label={cap.toUpperCase()}
                          size="small"
                          color={CAPABILITY_COLORS[cap as VoiceCapability] ?? 'default'}
                          variant="outlined"
                        />
                      ))}
                    </Stack>
                  </TableCell>
                  <TableCell sx={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {row.baseUrl}
                  </TableCell>
                  <TableCell align="right">
                    <Stack direction="row" spacing={1} sx={{
                      justifyContent: "flex-end"
                    }}>
                      <IconButton size="small" onClick={() => openEdit(row)}>
                        <EditIcon fontSize="small" />
                      </IconButton>
                      <IconButton size="small" color="error" onClick={() => handleDelete(row)}>
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}
              {!loading && items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} align="center">
                    <Typography variant="body2" sx={{
                      color: "text.secondary"
                    }}>
                      <I18nLabel id="voice_providerCatalogEmptyState" />
                    </Typography>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Box>
      </Stack>
      {/* Create/Edit Provider Dialog */}
      <Dialog
        open={dialogOpen}
        onClose={closeDialog}
        fullWidth
        maxWidth="sm"
        slotProps={{ backdrop: { sx: { backdropFilter: 'blur(6px)' } } }}
      >
        <DialogTitle>
          {editing ? <I18nLabel id="voice_providerCatalogSubmitUpdate" /> : <I18nLabel id="voice_providerCatalogSubmitCreate" />}
        </DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField
              label={<I18nLabel id="admin.features.colName" />}
              value={form.name}
              onChange={(e) => updateField('name', e.target.value)}
              disabled={saving}
              required
              error={formError === 'voice_errorLabelRequired'}
              helperText={formError === 'voice_errorLabelRequired' ? <I18nLabel id={formError} /> : undefined}
            />
            <TextField
              label={<I18nLabel id="voice_providerSlugField" />}
              value={form.slug}
              onChange={(e) => updateField('slug', e.target.value)}
              disabled={saving}
              required
              error={formError === 'voice_providerSlugField'}
              helperText={formError === 'voice_providerSlugField' ? <I18nLabel id="voice_errorLabelRequired" /> : undefined}
            />
            <TextField
              select
              label={<I18nLabel id="common.type" />}
              value={form.type}
              onChange={(e) => updateField('type', e.target.value)}
              disabled={saving}
              required
            >
              {PROVIDER_TYPES.map((t) => (
                <MenuItem key={t} value={t}>{t}</MenuItem>
              ))}
            </TextField>
            <Box>
              <Typography variant="body2" sx={{ mb: 0.5 }}>
                <I18nLabel id="voice_providerCapabilitiesField" />
              </Typography>
              <Stack direction="row" spacing={1}>
                {ALL_CAPABILITIES.map((cap) => (
                  <Chip
                    key={cap}
                    label={cap.toUpperCase()}
                    color={form.capabilities.includes(cap) ? CAPABILITY_COLORS[cap] : 'default'}
                    variant={form.capabilities.includes(cap) ? 'filled' : 'outlined'}
                    onClick={() => toggleCapability(cap)}
                    disabled={saving}
                  />
                ))}
              </Stack>
            </Box>
            <TextField
              label={<I18nLabel id="common.baseUrl" />}
              value={form.baseUrl}
              onChange={(e) => updateField('baseUrl', e.target.value)}
              disabled={saving}
              required
              error={formError === 'voice_errorBaseUrlRequired'}
              helperText={formError === 'voice_errorBaseUrlRequired' ? <I18nLabel id={formError} /> : undefined}
            />
            <TextField
              label={<I18nLabel id="voice_providerWebsiteField" />}
              value={form.website ?? ''}
              onChange={(e) => updateField('website', e.target.value)}
              disabled={saving}
            />
            <TextField
              label={<I18nLabel id="voice_providerSignupUrlField" />}
              value={form.signupUrl ?? ''}
              onChange={(e) => updateField('signupUrl', e.target.value)}
              disabled={saving}
            />
            {formError && formError !== 'voice_errorLabelRequired' && formError !== 'voice_providerSlugField' && formError !== 'voice_errorBaseUrlRequired' && (
              <Alert severity="error"><I18nLabel id={formError} /></Alert>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDialog} disabled={saving}>
            <I18nLabel id="common.cancel" />
          </Button>
          <Button onClick={handleSave} disabled={saving} variant="contained">
            {saving && <CircularProgress size={16} sx={{ mr: 1 }} />}
            {editing ? <I18nLabel id="voice_providerCatalogSubmitUpdate" /> : <I18nLabel id="voice_providerCatalogSubmitCreate" />}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default AdminVoiceProviderCatalog;
