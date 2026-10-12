/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { HttpResult } from '@/modules_shared/common/core/http/HttpResult';
import { httpResultToPromise } from '@/modules_shared/common/utils/httpResult';
import type { VoiceAccessCredentials, VoiceAccessCredentialsPayload, VoiceProviderCatalog, VoiceCapability } from '../../types';
import { i18n, type I18nLabelParams } from '@/modules_shared/common/core/i18n/I18n';
import { I18nLabel } from '@/modules_shared/common/components/ui/label/I18nLabel';
import Tooltip from '@mui/material/Tooltip';
import IconButton from '@mui/material/IconButton';
import Chip from '@mui/material/Chip';
import EditRounded from '@mui/icons-material/EditRounded';
import DeleteRounded from '@mui/icons-material/DeleteRounded';
import LockRounded from '@mui/icons-material/LockRounded';
import LockOpenRounded from '@mui/icons-material/LockOpenRounded';

type VoiceAccessFormState = {
  id: number | null;
  label: string;
  providerId: number | null;
  baseUrlOverride: string;
  useBaseUrlOverride: boolean;
  hasPassword: boolean;
  username: string;
  password: string;
  providerConfig: Record<string, any>;
};

type FormErrors = Partial<Record<'label' | 'provider', string>>;

const emptyForm: VoiceAccessFormState = {
  id: null,
  label: '',
  providerId: null,
  baseUrlOverride: '',
  useBaseUrlOverride: false,
  hasPassword: false,
  username: '',
  password: '',
  providerConfig: {},
};

export interface VoiceAccessCrudApi {
  list(): HttpResult;
  create(payload: VoiceAccessCredentialsPayload): HttpResult;
  update(id: number, payload: VoiceAccessCredentialsPayload): HttpResult;
  remove(id: number): HttpResult;
}

export interface VoiceAccessCrudProps {
  accessApi: VoiceAccessCrudApi;
  titleKey: string;
  descriptionKey: string;
  renderAfterDescription?: () => React.ReactNode;
  onListData?: (data: any) => void;
  providerCatalog: VoiceProviderCatalog[];
}

const CAPABILITY_COLORS: Record<VoiceCapability, 'primary' | 'secondary' | 'success'> = {
  tts: 'primary',
  stt: 'secondary',
  s2s: 'success',
};

const CAPABILITY_LABEL_KEYS: Record<VoiceCapability, string> = {
  tts: 'voice_capabilityTts',
  stt: 'voice_capabilityStt',
  s2s: 'voice_capabilityS2s',
};

function ProviderConfigFields({
  providerType,
  providerConfig,
  onChange,
  disabled,
}: {
  providerType: string | null;
  providerConfig: Record<string, any>;
  onChange: (config: Record<string, any>) => void;
  disabled: boolean;
}) {
  const getLabel = (key: string) => i18n.get(key);

  const updateField = (field: string, value: string) => {
    onChange({ ...providerConfig, [field]: value });
  };

  if (providerType === 'google-cloud') {
    return (
      <label>
        <span className="stat-label"><I18nLabel id="voice_configProjectIdField" /></span>
        <input
          value={providerConfig.projectId ?? ''}
          onChange={(e) => updateField('projectId', e.target.value)}
          placeholder={getLabel('voice_configProjectIdPlaceholder')}
          disabled={disabled}
        />
      </label>
    );
  }

  if (providerType === 'aws-polly') {
    return (
      <label>
        <span className="stat-label"><I18nLabel id="voice_configRegionField" /></span>
        <input
          value={providerConfig.region ?? ''}
          onChange={(e) => updateField('region', e.target.value)}
          placeholder={getLabel('voice_configRegionPlaceholder')}
          disabled={disabled}
        />
      </label>
    );
  }

  if (providerType === 'azure-tts') {
    return (
      <label>
        <span className="stat-label"><I18nLabel id="voice_configRegionField" /></span>
        <input
          value={providerConfig.region ?? ''}
          onChange={(e) => updateField('region', e.target.value)}
          placeholder={getLabel('voice_configRegionPlaceholder')}
          disabled={disabled}
        />
      </label>
    );
  }

  return null;
}

export function VoiceAccessCrud({
  accessApi,
  titleKey,
  descriptionKey,
  renderAfterDescription,
  onListData,
  providerCatalog,
}: VoiceAccessCrudProps) {
  const getLabel = useCallback(
    (key: string, params?: I18nLabelParams | null) => i18n.get(key, params),
    [],
  );

  const [accesses, setAccesses] = useState<VoiceAccessCredentials[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [formState, setFormState] = useState<VoiceAccessFormState>(emptyForm);
  const [formErrors, setFormErrors] = useState<FormErrors>({});
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [deleting, setDeleting] = useState<Record<number, boolean>>({});

  const selectedProvider = useMemo(
    () => providerCatalog.find((p) => p.id === formState.providerId) ?? null,
    [providerCatalog, formState.providerId],
  );

  const formIsValid =
    formState.label.trim().length >= 2 &&
    formState.providerId !== null;

  const validateForm = useCallback(
    (state: VoiceAccessFormState): FormErrors => {
      const errors: FormErrors = {};
      if (state.label.trim().length < 2) {
        errors.label = getLabel('voice_errorLabelRequired') ?? 'Label is required';
      }
      if (!state.providerId) {
        errors.provider = getLabel('voice_selectProvider') ?? 'Select a provider';
      }
      return errors;
    },
    [getLabel],
  );

  const editingLabel = formState.id ? getLabel('voice_editingLabel', [formState.label]) : null;

  const refreshAccesses = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await httpResultToPromise<any>(accessApi.list());
      setAccesses(data.accesses ?? []);
      onListData?.(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load accesses');
    } finally {
      setLoading(false);
    }
  }, [accessApi, onListData]);

  useEffect(() => {
    refreshAccesses();
  }, [refreshAccesses]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const errors = validateForm(formState);
    setFormErrors(errors);
    if (Object.keys(errors).length > 0 || formSubmitting) return;

    const providerConfig = Object.keys(formState.providerConfig).length > 0
      ? formState.providerConfig
      : undefined;

    const payload: VoiceAccessCredentialsPayload = {
      label: formState.label.trim(),
      providerId: formState.providerId!,
      baseUrlOverride: formState.useBaseUrlOverride ? (formState.baseUrlOverride.trim() || null) : null,
      username: formState.username?.trim() || undefined,
      password: formState.password?.trim() || undefined,
      providerConfig,
    };

    try {
      setFormSubmitting(true);
      setError(null);
      let access: VoiceAccessCredentials;
      if (formState.id) {
        access = await httpResultToPromise<VoiceAccessCredentials>(accessApi.update(formState.id, payload));
        setAccesses((prev) => prev.map((item) => (item.id === access.id ? access : item)));
      } else {
        access = await httpResultToPromise<VoiceAccessCredentials>(accessApi.create(payload));
        setAccesses((prev) => [access, ...prev]);
      }
      setFormState(emptyForm);
      setFormErrors({});
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save access');
    } finally {
      setFormSubmitting(false);
    }
  }

  async function handleDelete(id: number) {
    if (!window.confirm(getLabel('voice_deleteConfirm'))) return;

    try {
      setDeleting((prev) => ({ ...prev, [id]: true }));
      await httpResultToPromise(accessApi.remove(id));
      setAccesses((prev) => prev.filter((item) => item.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete access');
    } finally {
      setDeleting((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  }

  function startEditing(access: VoiceAccessCredentials) {
    const hasBaseUrlOverride = Boolean(access.baseUrlOverride);
    setFormState({
      id: access.id,
      label: access.label,
      providerId: access.provider?.id ?? null,
      baseUrlOverride: access.baseUrlOverride ?? '',
      useBaseUrlOverride: hasBaseUrlOverride,
      hasPassword: access.hasPassword,
      username: access.username ?? '',
      password: '',
      providerConfig: access.providerConfig ?? {},
    });
  }

  function resetForm() {
    setFormState(emptyForm);
    setFormErrors({});
  }

  return (
    <section className="page-section">
      <div className="section-header">
        <div>
          <h3><I18nLabel id={titleKey} /></h3>
          <p className="subtext"><I18nLabel id={descriptionKey} /></p>
          {renderAfterDescription?.()}
        </div>
      </div>
      {error ? (
        <p className="subtext" style={{ color: 'var(--color-danger)' }}>{error}</p>
      ) : null}
      {loading ? (
        <p className="subtext"><I18nLabel id="common.loading" /></p>
      ) : (
        <>
          <form className="form-grid" onSubmit={handleSubmit}>
            <label>
              <span className="stat-label"><I18nLabel id="common.label" /> *</span>
              <input
                value={formState.label}
                onChange={(e) => {
                  setFormState((prev) => ({ ...prev, label: e.target.value }));
                  if (formErrors.label && e.target.value.trim().length >= 2) {
                    setFormErrors((prev) => { const n = { ...prev }; delete n.label; return n; });
                  }
                }}
                placeholder="My ElevenLabs Access"
                required
                disabled={formSubmitting}
                aria-invalid={Boolean(formErrors.label)}
                style={formErrors.label ? { borderColor: 'var(--color-danger)' } : undefined}
              />
              {formErrors.label ? (
                <small className="subtext" style={{ marginTop: '0.35rem', color: 'var(--color-danger)', display: 'block' }}>
                  {formErrors.label}
                </small>
              ) : null}
            </label>

            <label>
              <span className="stat-label"><I18nLabel id="voice_selectProvider" /> *</span>
              <select
                value={formState.providerId ?? ''}
                onChange={(e) => {
                  const id = e.target.value ? Number(e.target.value) : null;
                  setFormState((prev) => ({ ...prev, providerId: id, providerConfig: {} }));
                  if (formErrors.provider && id) {
                    setFormErrors((prev) => { const n = { ...prev }; delete n.provider; return n; });
                  }
                }}
                disabled={formSubmitting}
              >
                <option value="">-- {getLabel('voice_selectProvider')} --</option>
                {providerCatalog.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.capabilities.join(', ')})
                  </option>
                ))}
              </select>
              {formErrors.provider ? (
                <small className="subtext" style={{ marginTop: '0.35rem', color: 'var(--color-danger)', display: 'block' }}>
                  {formErrors.provider}
                </small>
              ) : null}
            </label>

            <label>
              <span className="stat-label"><I18nLabel id="voice_usernameField" /></span>
              <input
                value={formState.username}
                onChange={(e) => setFormState((prev) => ({ ...prev, username: e.target.value }))}
                autoComplete="username"
                placeholder={getLabel('voice_usernamePlaceholder')}
                disabled={formSubmitting}
              />
            </label>
            <label>
              <span className="stat-label"><I18nLabel id="voice_passwordField" /></span>
              <input
                type="password"
                value={formState.password}
                onChange={(e) => setFormState((prev) => ({ ...prev, password: e.target.value }))}
                autoComplete="current-password"
                placeholder={getLabel('voice_passwordPlaceholder')}
                disabled={formSubmitting}
              />
              {(formState.hasPassword && formState.id) || formState.password ? (
                <small className="subtext" style={{ marginTop: '0.35rem', display: 'block' }}>
                  <I18nLabel id="voice_passwordHint" />
                </small>
              ) : null}
            </label>

            {selectedProvider ? (
              <ProviderConfigFields
                providerType={selectedProvider.type}
                providerConfig={formState.providerConfig}
                onChange={(config) => setFormState((prev) => ({ ...prev, providerConfig: config }))}
                disabled={formSubmitting}
              />
            ) : null}

            {formState.providerId ? (
              <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                  <input
                    type="checkbox"
                    checked={formState.useBaseUrlOverride}
                    onChange={(e) => setFormState((prev) => ({
                      ...prev,
                      useBaseUrlOverride: e.target.checked,
                      baseUrlOverride: e.target.checked ? prev.baseUrlOverride : '',
                    }))}
                    disabled={formSubmitting}
                  />
                  <small className="subtext"><I18nLabel id="voice_overrideBaseUrl" /></small>
                </label>
                {formState.useBaseUrlOverride ? (
                  <input
                    type="url"
                    value={formState.baseUrlOverride}
                    onChange={(e) => setFormState((prev) => ({ ...prev, baseUrlOverride: e.target.value }))}
                    placeholder={selectedProvider?.baseUrl ?? 'https://'}
                    style={{ flex: 1 }}
                    disabled={formSubmitting}
                  />
                ) : null}
              </div>
            ) : null}

            <div className="form-actions" style={{ gridColumn: '1 / -1', justifyContent: 'flex-end' }}>
              {editingLabel ? <span className="subtext">{editingLabel}</span> : null}
              <button type="button" className="ghost-btn" onClick={resetForm} disabled={formSubmitting}>
                <I18nLabel id="common.cancel" />
              </button>
              <button type="submit" className="primary-btn" disabled={!formIsValid || formSubmitting}>
                {formSubmitting
                  ? getLabel('voice_savingLabel')
                  : formState.id
                    ? getLabel('common.update')
                    : getLabel('voice_submitCreate')}
              </button>
            </div>
          </form>

          {accesses.length ? (
            <table className="list-table list-table--compact">
              <thead>
                <tr>
                  <th><I18nLabel id="common.label" /></th>
                  <th><I18nLabel id="common.provider" /></th>
                  <th><I18nLabel id="voice_tableColumnCapabilities" /></th>
                  <th><I18nLabel id="common.baseUrl" /></th>
                  <th><I18nLabel id="voice_tableColumnAuth" /></th>
                  <th style={{ textAlign: 'center' }}><I18nLabel id="common.actions" /></th>
                </tr>
              </thead>
              <tbody>
                {accesses.map((access) => (
                  <tr key={access.id}>
                    <td>{access.label}</td>
                    <td>
                      <div>{access.provider?.name ?? '\u2014'}</div>
                      <small className="subtext">{access.provider?.type}</small>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
                        {(access.provider?.capabilities ?? []).map((cap) => (
                          <Chip
                            key={cap}
                            label={getLabel(CAPABILITY_LABEL_KEYS[cap]) ?? cap.toUpperCase()}
                            size="small"
                            color={CAPABILITY_COLORS[cap]}
                            variant="outlined"
                          />
                        ))}
                      </div>
                    </td>
                    <td style={{ maxWidth: '180px', wordBreak: 'break-all' }}>
                      <small>{access.baseUrlOverride ?? access.provider?.baseUrl}</small>
                      {access.baseUrlOverride ? (
                        <small className="subtext" style={{ display: 'block' }}>{getLabel('voice_overrideBaseUrl')}</small>
                      ) : null}
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                        <Tooltip title={access.hasPassword
                          ? getLabel('voice_secretSet')
                          : getLabel('voice_secretMissing')}>
                          {access.hasPassword
                            ? <LockRounded sx={{ fontSize: 16, color: 'var(--color-success)' }} />
                            : <LockOpenRounded sx={{ fontSize: 16, color: 'var(--color-text-muted)' }} />}
                        </Tooltip>
                        {access.username ? <small className="subtext">{access.username}</small> : null}
                      </div>
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.1rem' }}>
                        <Tooltip title={getLabel('common.edit')}>
                          <IconButton size="small" onClick={() => startEditing(access)}>
                            <EditRounded fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title={getLabel('common.delete')}>
                          <span>
                            <IconButton
                              size="small"
                              onClick={() => handleDelete(access.id)}
                              disabled={Boolean(deleting[access.id])}
                              color="error"
                            >
                              <DeleteRounded fontSize="small" />
                            </IconButton>
                          </span>
                        </Tooltip>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty-state">
              <I18nLabel id="voice_emptyState" />
            </div>
          )}
        </>
      )}
    </section>
  );
}
