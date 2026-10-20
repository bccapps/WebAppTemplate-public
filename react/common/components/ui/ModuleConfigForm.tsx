/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import '../../styles/tokens.css';
import React from 'react';
import { i18n } from '@/modules_shared/common/core/i18n/I18n';
import { moduleConfigService } from '@/modules_shared/common/services/ModuleConfigService';
import { routeRegistry } from '@/modules_shared/common/services/RouteRegistry';
import type { ConfigFieldOption, ConfigFieldSchema, ModuleConfigWithValues } from '@/modules_shared/common/types/ModuleConfigSchema';
import '@/styles/theme_default.css';

interface ModuleConfigFormProps {
  moduleId: string;
  /** Optional filter: only show fields from these groups. Show all if omitted. */
  groups?: string[];
  /** Field keys for which to show a copy-to-clipboard button. */
  copyableKeys?: string[];
}

const ModuleConfigForm: React.FC<ModuleConfigFormProps> = ({ moduleId, groups, copyableKeys }) => {
  const [config, setConfig] = React.useState<ModuleConfigWithValues | null>(null);
  const [values, setValues] = React.useState<Record<string, any>>({});
  const [originalValues, setOriginalValues] = React.useState<Record<string, any>>({});
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);
  const [copiedKey, setCopiedKey] = React.useState<string | null>(null);
  const [revealedValues, setRevealedValues] = React.useState<Record<string, string>>({});
  const [revealingKey, setRevealingKey] = React.useState<string | null>(null);

  const handleCopy = React.useCallback(async (key: string, value: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((prev) => (prev === key ? null : prev)), 2000);
    } catch {
      // Clipboard API unavailable
    }
  }, []);

  const handleReveal = React.useCallback(async (key: string) => {
    setRevealingKey(key);
    try {
      const value = await moduleConfigService.getSecretValue(moduleId, key);
      setRevealedValues((prev) => ({ ...prev, [key]: value }));
    } catch {
      // Leave the field hidden on failure
    } finally {
      setRevealingKey((prev) => (prev === key ? null : prev));
    }
  }, [moduleId]);

  const handleHide = React.useCallback((key: string) => {
    setRevealedValues((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const buildValues = React.useCallback((data: ModuleConfigWithValues, filterGroups?: string[]): Record<string, any> => {
    const vals: Record<string, any> = {};
    for (const field of data.fields) {
      if (filterGroups && filterGroups.length > 0 && !filterGroups.includes(field.group ?? '')) continue;
      // Secret fields: backend never sends the value — keep null so the UI shows write-only state
      if (field.type === 'secret') {
        vals[field.key] = null;
      } else {
        vals[field.key] = data.currentValues[field.key] ?? field.defaultValue ?? '';
      }
    }
    return vals;
  }, []);

  const fetchConfig = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await moduleConfigService.getModuleConfig(moduleId);
      if (data) {
        setConfig(data);
        const v = buildValues(data, groups);
        setValues(v);
        setOriginalValues(JSON.parse(JSON.stringify(v)));
        setRevealedValues({});
      }
    } catch (err: any) {
      setError(err?.message || i18n.get('common.error.generic'));
    } finally {
      setLoading(false);
    }
  }, [moduleId, groups, buildValues]);

  React.useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const hasChanges = React.useMemo(
    () => JSON.stringify(values) !== JSON.stringify(originalValues),
    [values, originalValues],
  );

  const handleChange = React.useCallback((key: string, value: any) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setSuccess(null);
  }, []);

  const handleSave = React.useCallback(async () => {
    if (!hasChanges || saving) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const updated = await moduleConfigService.updateModuleConfig(moduleId, values);
      if (updated) {
        setConfig(updated);
        const v = buildValues(updated, groups);
        setValues(v);
        setOriginalValues(JSON.parse(JSON.stringify(v)));
        setRevealedValues({});
        setSuccess(i18n.get('common.config.module.saved'));
      }
    } catch (err: any) {
      setError(err?.message || i18n.get('common.error.generic'));
    } finally {
      setSaving(false);
    }
  }, [moduleId, hasChanges, saving, values, groups, buildValues]);

  const handleReset = React.useCallback(() => {
    setValues(JSON.parse(JSON.stringify(originalValues)));
    setSuccess(null);
  }, [originalValues]);

  /**
   * A field carrying `visibleWhen` is only rendered when the driver field's
   * current value is listed. The driver value is read from the live form state
   * first so the form reacts immediately to a change, and falls back to the
   * persisted value when the driver sits outside the rendered groups.
   */
  const isFieldVisible = (field: ConfigFieldSchema): boolean => {
    const condition = field.visibleWhen;
    if (!condition) return true;
    const driver = config?.fields.find((f) => f.key === condition.field);
    const driverValue = values[condition.field]
      ?? config?.currentValues[condition.field]
      ?? driver?.defaultValue
      ?? '';
    return condition.in.includes(String(driverValue));
  };

  const resolveOptions = (field: ConfigFieldSchema): ConfigFieldOption[] => {
    if (!field.dynamicOptionsKey) return field.options ?? [];
    const dynamic = routeRegistry.get(field.dynamicOptionsKey);
    const seen = new Set(dynamic.map((o) => o.value));
    const staticOnly = (field.options ?? []).filter((o) => !seen.has(o.value));
    return [...dynamic, ...staticOnly];
  };

  const renderField = (field: ConfigFieldSchema) => {
    const key = field.key;
    const val = values[key] ?? field.defaultValue ?? '';
    const label = i18n.get(field.label) || field.label;
    const desc = field.description ? (i18n.get(field.description) || field.description) : null;

    const descEl = desc ? <small className="subtext">{desc}</small> : null;

    if (field.type === 'boolean') {
      const checked = val === true || val === 'true' || val === '1';
      return (
        <label key={key} className="field" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem' }}>
          <span style={{ display: 'flex', flexDirection: 'column' }}>
            <span className="stat-label">{label}</span>
            {descEl}
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={checked}
            onChange={(e) => handleChange(key, e.target.checked)}
            disabled={saving}
            style={{ marginTop: '0.2rem' }}
          />
        </label>
      );
    }

    if (field.type === 'number') {
      return (
        <label key={key} className="field">
          <span className="stat-label">{label}</span>
          <input
            type="number"
            value={val}
            onChange={(e) => handleChange(key, e.target.value === '' ? '' : Number(e.target.value))}
            disabled={saving}
            min={field.validation?.min}
            max={field.validation?.max}
          />
          {descEl}
        </label>
      );
    }

    if (field.type === 'select') {
      return (
        <label key={key} className="field">
          <span className="stat-label">{label}</span>
          <select value={val} onChange={(e) => handleChange(key, e.target.value)} disabled={saving}>
            {resolveOptions(field).map((opt) => (
              <option key={opt.value} value={opt.value}>
                {i18n.get(opt.label) || opt.label}
              </option>
            ))}
          </select>
          {descEl}
        </label>
      );
    }

    if (field.type === 'multiselect') {
      const selected: string[] = Array.isArray(val) ? val : [];
      return (
        <label key={key} className="field">
          <span className="stat-label">{label}</span>
          <select
            multiple
            value={selected}
            onChange={(e) => {
              const opts = Array.from(e.target.selectedOptions, (o) => o.value);
              handleChange(key, opts);
            }}
            disabled={saving}
          >
            {resolveOptions(field).map((opt) => (
              <option key={opt.value} value={opt.value}>
                {i18n.get(opt.label) || opt.label}
              </option>
            ))}
          </select>
          {descEl}
        </label>
      );
    }

    if (field.type === 'json') {
      const strVal = typeof val === 'string' ? val : JSON.stringify(val, null, 2);
      return (
        <label key={key} className="field">
          <span className="stat-label">{label}</span>
          <textarea
            rows={4}
            value={strVal}
            onChange={(e) => handleChange(key, e.target.value)}
            disabled={saving}
            style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}
          />
          {descEl}
        </label>
      );
    }

    const isSecret = field.type === 'secret';
    const secretIsSet = isSecret && (config?.secretsIsSet?.[key] ?? false);
    const isRevealable = isSecret && copyableKeys?.includes(key);
    const revealedVal = revealedValues[key];
    const isRevealed = isRevealable && revealedVal !== undefined;
    const isRevealing = revealingKey === key;
    // For a secret field, val is null when untouched — use empty string for the input
    const inputVal = isRevealed ? revealedVal : (isSecret ? (val ?? '') : val);

    const isCopyable = isRevealed || (!isSecret && copyableKeys?.includes(key));
    const copyValue = isRevealed ? revealedVal : String(val);
    const isCopied = copiedKey === key;
    const btnStyle = {
      flexShrink: 0,
      padding: '0.25rem 0.5rem',
      fontSize: '0.75rem',
      border: '1px solid var(--common-moduleconfig-border)',
      borderRadius: '4px',
      background: 'transparent',
      color: 'inherit',
      whiteSpace: 'nowrap' as const,
    };
    return (
      <label key={key} className="field">
        <span className="stat-label">{label}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <input
            style={{ flex: 1, minWidth: 0 }}
            type={isRevealed ? 'text' : (isSecret ? 'password' : 'text')}
            value={inputVal}
            placeholder={isSecret && secretIsSet && !inputVal ? i18n.get('common.config.secret.set') : undefined}
            onChange={(e) => handleChange(key, e.target.value || null)}
            readOnly={isRevealed}
            disabled={saving}
          />
          {isRevealable && (
            <button
              type="button"
              title={i18n.get(isRevealed ? 'common.config.secret.hide' : 'common.config.secret.reveal')}
              onClick={() => (isRevealed ? handleHide(key) : handleReveal(key))}
              disabled={isRevealing || saving || !secretIsSet}
              style={{
                ...btnStyle,
                cursor: !secretIsSet ? 'default' : 'pointer',
                opacity: !secretIsSet ? 0.4 : 1,
              }}
            >
              {isRevealing ? '…' : isRevealed ? '🙈' : '👁'}
            </button>
          )}
          {isCopyable && (
            <button
              type="button"
              title={isCopied ? i18n.get('common.copied') : i18n.get('common.copy')}
              onClick={() => handleCopy(key, copyValue)}
              disabled={!copyValue}
              style={{
                ...btnStyle,
                cursor: copyValue ? 'pointer' : 'default',
                opacity: copyValue ? 1 : 0.4,
                background: isCopied ? 'var(--common-moduleconfig-copied-bg)' : 'transparent',
                color: isCopied ? 'var(--common-moduleconfig-copied-fg)' : 'inherit',
                transition: 'background 0.2s, color 0.2s',
              }}
            >
              {isCopied ? '✓' : '⎘'}
            </button>
          )}
        </span>
        {descEl}
      </label>
    );
  };

  if (loading) {
    return <div className="empty-state">{i18n.get('common.loading')}</div>;
  }

  if (!config) return null;

  const groupedFields = groups && groups.length > 0
    ? config.fields.filter((f) => groups.includes(f.group ?? ''))
    : config.fields;

  const visibleFields = groupedFields.filter((f) => !f.hidden && isFieldVisible(f));

  // Group fields by group property
  const fieldsByGroup = visibleFields.reduce<Record<string, ConfigFieldSchema[]>>((acc, f) => {
    const g = f.group || 'general';
    if (!acc[g]) acc[g] = [];
    acc[g].push(f);
    return acc;
  }, {});

  const groupNames = Object.keys(fieldsByGroup).sort();

  return (
    <div className="page-stack">
      {error && <div className="alert alert--error" role="alert">{error}</div>}
      {success && <div className="alert alert--success" role="alert">{success}</div>}

      {groupNames.map((groupName) => (
        <article key={groupName} className="page-subsection">
          <div className="section-header">
            <h3>{i18n.get(`common.config.groups.${groupName}`) || groupName.charAt(0).toUpperCase() + groupName.slice(1)}</h3>
          </div>
          <div className="form-grid">
            {fieldsByGroup[groupName].map((field) => renderField(field))}
          </div>
        </article>
      ))}

      <div className="section-actions" style={{ justifyContent: 'flex-end' }}>
        <button
          type="button"
          className="outline-btn"
          onClick={handleReset}
          disabled={!hasChanges || saving}
        >
          {i18n.get('common.config.actions.reset')}
        </button>
        <button
          type="button"
          className="primary-btn"
          onClick={handleSave}
          disabled={!hasChanges || saving}
        >
          {saving ? <span className="button-spinner" aria-hidden /> : i18n.get('common.save')}
        </button>
      </div>
    </div>
  );
};

export default ModuleConfigForm;
