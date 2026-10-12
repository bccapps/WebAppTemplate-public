/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

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
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import EditRoundedIcon from '@mui/icons-material/EditRounded';
import DeleteRoundedIcon from '@mui/icons-material/DeleteRounded';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import { useTheme } from '@mui/material/styles';
import { httpService } from '@/modules_shared/common/core/http/HttpService';
import { configurationService } from '@/modules_shared/common/services/ConfigurationService';
import { I18nLabel } from '@/modules_shared/common/components/ui/label/I18nLabel';

type FeatureEntry = Record<string, any>;
type FeaturesMap = Record<string, FeatureEntry>;

const RESERVED_KEYS = new Set(['enabled', 'description']);

const getCustomProps = (feature: FeatureEntry): string[] =>
  Object.keys(feature).filter((k) => !RESERVED_KEYS.has(k));

const httpResultToPromise = <T = any,>(result: any): Promise<T> =>
  new Promise((resolve, reject) => {
    if (result?.then && result?.fail) {
      result.then((v: T) => resolve(v)).fail(reject).error(reject).notAuthorized(reject);
    } else if (result?.then) {
      result.then((v: T) => resolve(v)).catch(reject);
    } else {
      resolve(result as T);
    }
  });

const parseFeatures = (raw: any): { features: FeaturesMap; jsonError: string | null } => {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        return { features: parsed, jsonError: null };
    } catch (e: any) {
      return { features: {}, jsonError: e?.message ?? 'Invalid JSON' };
    }
    return { features: {}, jsonError: null };
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw))
    return { features: raw as FeaturesMap, jsonError: null };
  return { features: {}, jsonError: null };
};

const AdminFeatures = () => {
  const theme = useTheme();
  const [features, setFeatures] = useState<FeaturesMap>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jsonWarning, setJsonWarning] = useState<string | null>(null);
  const [configDescription, setConfigDescription] = useState('');

  // Add dialog
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState('');
  const [addDescription, setAddDescription] = useState('');
  const [addError, setAddError] = useState<string | null>(null);

  // Edit dialog
  const [editOpen, setEditOpen] = useState(false);
  const [editOldName, setEditOldName] = useState('');
  const [editNewName, setEditNewName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editProperties, setEditProperties] = useState<string[]>([]);
  const [editError, setEditError] = useState<string | null>(null);
  const [newPropName, setNewPropName] = useState('');
  const [propError, setPropError] = useState<string | null>(null);

  // Delete dialog
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteName, setDeleteName] = useState('');

  const featureNames = useMemo(() => Object.keys(features).sort(), [features]);

  const loadFeatures = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const endpoint = `${configurationService.getApiUrl()}/configurations`;
      const data = await httpResultToPromise<any[]>(httpService.get(endpoint));
      const row = data?.find((r: any) => r.name === 'features');
      if (row) {
        const { features: parsed, jsonError } = parseFeatures(row.value);
        setFeatures(parsed);
        setJsonWarning(jsonError);
        setConfigDescription(row.description ?? '');
      } else {
        setFeatures({});
        setJsonWarning(null);
      }
    } catch {
      setError('Failed to load features');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFeatures();
  }, [loadFeatures]);

  const persistFeatures = useCallback(
    async (updated: FeaturesMap) => {
      setSaving(true);
      setError(null);
      try {
        const endpoint = `${configurationService.getApiUrl()}/configurations`;
        const value = JSON.stringify(updated);
        await httpResultToPromise(
          httpService.put(endpoint, [{ name: 'features', value, description: configDescription }]),
        );
        setFeatures(updated);
        setJsonWarning(null);
        configurationService.set('features', value);
      } catch {
        setError('Failed to save features');
      } finally {
        setSaving(false);
      }
    },
    [configDescription],
  );

  // Toggle
  const handleToggle = useCallback(
    (name: string) => {
      const f = features[name] ?? {};
      const updated = { ...features, [name]: { ...f, enabled: !f.enabled } };
      persistFeatures(updated);
    },
    [features, persistFeatures],
  );

  // Add
  const openAdd = useCallback(() => {
    setAddName('');
    setAddDescription('');
    setAddError(null);
    setAddOpen(true);
  }, []);

  const confirmAdd = useCallback(() => {
    const trimmed = addName.trim();
    if (!trimmed) {
      setAddError('admin.features.errorEmpty');
      return;
    }
    if (features[trimmed]) {
      setAddError('admin.features.errorExists');
      return;
    }
    const entry: FeatureEntry = { enabled: false };
    if (addDescription.trim()) entry.description = addDescription.trim();
    const updated = { ...features, [trimmed]: entry };
    persistFeatures(updated);
    setAddOpen(false);
  }, [addName, addDescription, features, persistFeatures]);

  // Edit
  const openEdit = useCallback(
    (name: string) => {
      const f = features[name] ?? {};
      setEditOldName(name);
      setEditNewName(name);
      setEditDescription(f.description ?? '');
      setEditProperties(getCustomProps(f));
      setEditError(null);
      setNewPropName('');
      setPropError(null);
      setEditOpen(true);
    },
    [features],
  );

  const confirmEdit = useCallback(() => {
    const trimmed = editNewName.trim();
    if (!trimmed) {
      setEditError('admin.features.errorEmpty');
      return;
    }
    if (trimmed !== editOldName && features[trimmed]) {
      setEditError('admin.features.errorExists');
      return;
    }

    const oldFeature = features[editOldName] ?? {};
    const newFeature: FeatureEntry = { enabled: oldFeature.enabled ?? false };
    if (editDescription.trim()) newFeature.description = editDescription.trim();
    for (const prop of editProperties) {
      newFeature[prop] = oldFeature[prop] ?? '';
    }

    const updated: FeaturesMap = {};
    for (const key of Object.keys(features)) {
      if (key === editOldName) {
        updated[trimmed] = newFeature;
      } else {
        updated[key] = features[key];
      }
    }
    if (!(editOldName in features)) {
      updated[trimmed] = newFeature;
    }
    persistFeatures(updated);
    setEditOpen(false);
  }, [editNewName, editOldName, editDescription, editProperties, features, persistFeatures]);

  const handleAddProperty = useCallback(() => {
    const trimmed = newPropName.trim();
    if (!trimmed) return;
    if (RESERVED_KEYS.has(trimmed)) {
      setPropError('admin.features.propertyReserved');
      return;
    }
    if (editProperties.includes(trimmed)) {
      setPropError('admin.features.propertyExists');
      return;
    }
    setEditProperties((prev) => [...prev, trimmed]);
    setNewPropName('');
    setPropError(null);
  }, [newPropName, editProperties]);

  const handleRemoveProperty = useCallback((prop: string) => {
    setEditProperties((prev) => prev.filter((p) => p !== prop));
  }, []);

  // Delete
  const openDelete = useCallback((name: string) => {
    setDeleteName(name);
    setDeleteOpen(true);
  }, []);

  const confirmDelete = useCallback(() => {
    const updated = { ...features };
    delete updated[deleteName];
    persistFeatures(updated);
    setDeleteOpen(false);
  }, [deleteName, features, persistFeatures]);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      {/* Header */}
      <Stack
        direction="row"
        sx={{
          alignItems: "center",
          justifyContent: "space-between",
          mb: 2
        }}>
        <Typography variant="h6" sx={{
          fontWeight: 700
        }}>
          <I18nLabel id="admin.features.title" />
        </Typography>
        <Button
          variant="contained"
          size="small"
          startIcon={<AddRoundedIcon />}
          onClick={openAdd}
          disabled={saving}
        >
          <I18nLabel id="admin.features.add" />
        </Button>
      </Stack>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      {jsonWarning && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          <I18nLabel id="admin.features.jsonInvalid" /> — {jsonWarning}
        </Alert>
      )}
      {featureNames.length === 0 ? (
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
            py: 4,
            textAlign: 'center'
          }}>
          <I18nLabel id="admin.features.empty" />
        </Typography>
      ) : (
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>
                  <I18nLabel id="admin.features.colName" />
                </TableCell>
                <TableCell>
                  <I18nLabel id="common.bugReport.description" />
                </TableCell>
                <TableCell>
                  <I18nLabel id="admin.features.colProperties" />
                </TableCell>
                <TableCell align="center">
                  <I18nLabel id="admin.features.colEnabled" />
                </TableCell>
                <TableCell align="right">
                  <I18nLabel id="common.actions" />
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {featureNames.map((name) => {
                const f = features[name] ?? {};
                const props = getCustomProps(f);
                return (
                  <TableRow key={name}>
                    <TableCell>
                      <Typography
                        variant="body2"
                        sx={{
                          fontWeight: 500,
                          fontFamily: 'monospace'
                        }}>
                        {name}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption" sx={{
                        color: "text.secondary"
                      }}>
                        {f.description || '-'}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      {props.length > 0 ? (
                        <Stack direction="row" spacing={0.5} useFlexGap sx={{
                          flexWrap: "wrap"
                        }}>
                          {props.map((p) => (
                            <Chip key={p} label={p} size="small" variant="outlined" />
                          ))}
                        </Stack>
                      ) : (
                        <Typography variant="caption" sx={{
                          color: "text.disabled"
                        }}>
                          -
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell align="center">
                      <Switch
                        checked={!!f.enabled}
                        onChange={() => handleToggle(name)}
                        disabled={saving}
                        size="small"
                      />
                    </TableCell>
                    <TableCell align="right">
                      <IconButton size="small" onClick={() => openEdit(name)} disabled={saving}>
                        <EditRoundedIcon fontSize="small" />
                      </IconButton>
                      <IconButton
                        size="small"
                        onClick={() => openDelete(name)}
                        disabled={saving}
                        sx={{ '&:hover': { color: theme.palette.error.main } }}
                      >
                        <DeleteRoundedIcon fontSize="small" />
                      </IconButton>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      {/* Add dialog */}
      <Dialog
        open={addOpen}
        onClose={() => !saving && setAddOpen(false)}
        maxWidth="xs"
        fullWidth
        slotProps={{ backdrop: { sx: { backdropFilter: 'blur(4px)' } } }}
      >
        <DialogTitle>
          <I18nLabel id="admin.features.addTitle" />
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField
              autoFocus
              fullWidth
              label={<I18nLabel id="admin.features.fieldName" />}
              value={addName}
              onChange={(e) => {
                setAddName(e.target.value);
                setAddError(null);
              }}
              onKeyDown={(e) => e.key === 'Enter' && confirmAdd()}
              error={!!addError}
              helperText={addError ? <I18nLabel id={addError} /> : undefined}
              disabled={saving}
              required
            />
            <TextField
              fullWidth
              label={<I18nLabel id="common.bugReport.description" />}
              value={addDescription}
              onChange={(e) => setAddDescription(e.target.value)}
              disabled={saving}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAddOpen(false)} disabled={saving}>
            <I18nLabel id="common.cancel" />
          </Button>
          <Button variant="contained" onClick={confirmAdd} disabled={saving || !addName.trim()}>
            {saving ? <CircularProgress size={18} /> : <I18nLabel id="admin.features.add" />}
          </Button>
        </DialogActions>
      </Dialog>
      {/* Edit dialog */}
      <Dialog
        open={editOpen}
        onClose={() => !saving && setEditOpen(false)}
        maxWidth="sm"
        fullWidth
        slotProps={{ backdrop: { sx: { backdropFilter: 'blur(4px)' } } }}
      >
        <DialogTitle>
          <I18nLabel id="admin.features.editTitle" />
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField
              autoFocus
              fullWidth
              label={<I18nLabel id="admin.features.fieldName" />}
              value={editNewName}
              onChange={(e) => {
                setEditNewName(e.target.value);
                setEditError(null);
              }}
              error={!!editError}
              helperText={editError ? <I18nLabel id={editError} /> : undefined}
              disabled={saving}
              required
            />
            <TextField
              fullWidth
              label={<I18nLabel id="common.bugReport.description" />}
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
              disabled={saving}
            />

            {/* Properties section */}
            <Box>
              <Typography
                variant="subtitle2"
                sx={{
                  fontWeight: 600,
                  mb: 1
                }}>
                <I18nLabel id="admin.features.properties" />
              </Typography>
              {editProperties.length > 0 ? (
                <Stack spacing={0.5} sx={{ mb: 1.5 }}>
                  {editProperties.map((prop) => (
                    <Stack key={prop} direction="row" spacing={1} sx={{
                      alignItems: "center"
                    }}>
                      <Chip label={prop} size="small" variant="outlined" sx={{ fontFamily: 'monospace' }} />
                      <IconButton
                        size="small"
                        onClick={() => handleRemoveProperty(prop)}
                        disabled={saving}
                        sx={{ '&:hover': { color: theme.palette.error.main } }}
                      >
                        <CloseRoundedIcon sx={{ fontSize: 16 }} />
                      </IconButton>
                    </Stack>
                  ))}
                </Stack>
              ) : (
                <Typography
                  variant="caption"
                  sx={{
                    color: "text.disabled",
                    mb: 1.5,
                    display: 'block'
                  }}>
                  -
                </Typography>
              )}
              <Stack direction="row" spacing={1} sx={{
                alignItems: "flex-start"
              }}>
                <TextField
                  size="small"
                  label={<I18nLabel id="admin.features.propertyName" />}
                  value={newPropName}
                  onChange={(e) => {
                    setNewPropName(e.target.value);
                    setPropError(null);
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddProperty()}
                  error={!!propError}
                  helperText={propError ? <I18nLabel id={propError} /> : undefined}
                  disabled={saving}
                  sx={{ flex: 1 }}
                />
                <Button
                  size="small"
                  variant="outlined"
                  onClick={handleAddProperty}
                  disabled={saving || !newPropName.trim()}
                  sx={{ mt: '4px' }}
                >
                  <I18nLabel id="admin.features.addProperty" />
                </Button>
              </Stack>
            </Box>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditOpen(false)} disabled={saving}>
            <I18nLabel id="common.cancel" />
          </Button>
          <Button variant="contained" onClick={confirmEdit} disabled={saving || !editNewName.trim()}>
            {saving ? <CircularProgress size={18} /> : <I18nLabel id="common.save" />}
          </Button>
        </DialogActions>
      </Dialog>
      {/* Delete confirmation dialog */}
      <Dialog
        open={deleteOpen}
        onClose={() => !saving && setDeleteOpen(false)}
        maxWidth="xs"
        fullWidth
        slotProps={{ backdrop: { sx: { backdropFilter: 'blur(4px)' } } }}
      >
        <DialogTitle>
          <I18nLabel id="admin.features.deleteTitle" />
        </DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            <I18nLabel id="admin.features.deleteConfirm" />
            <Box component="span" sx={{ fontFamily: 'monospace', fontWeight: 700, ml: 0.5 }}>
              {deleteName}
            </Box>
            ?
          </Typography>
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
              mt: 1,
              display: 'block'
            }}>
            <I18nLabel id="admin.features.deleteWarning" />
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteOpen(false)} disabled={saving}>
            <I18nLabel id="common.cancel" />
          </Button>
          <Button variant="contained" color="error" onClick={confirmDelete} disabled={saving}>
            {saving ? <CircularProgress size={18} /> : <I18nLabel id="common.delete" />}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default AdminFeatures;
