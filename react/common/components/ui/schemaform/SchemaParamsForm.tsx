/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useState } from 'react';
import type { ReactNode } from 'react';
import { Box, Button, Collapse, MenuItem, Slider, Switch, TextField, Typography } from '@mui/material';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { i18n } from '../../../core/i18n/I18n';
import { useI18nVersion } from '../../../hooks/useI18nVersion';
import { LabelWithTip } from '../help/LabelWithTip';
import { buildControls, coerceValue, defaultValues } from './schemaControls';
import type { ControlModel } from './schemaControls';
import type { ParamField, ParamsSchema, ParamValue, ParamValues } from './schemaTypes';

export interface SchemaParamsFormProps {
  schema: ParamsSchema;
  values: ParamValues;
  /** Receives the changed value(s) only, already normalized (clamped, rounded). */
  onChange: (patch: Record<string, ParamValue>) => void;
  /** Title row (i18n key); the row (title + reset button) is hidden when omitted. */
  titleId?: string;
  /** Extra content shown after the basic controls (a seed field, for instance). */
  children?: ReactNode;
}

function findField(schema: ParamsSchema, key: string): ParamField | undefined {
  return schema.find((field) => field.key === key);
}

function ControlRow({ control, onValue }: { control: ControlModel; onValue: (raw: unknown) => void }) {
  const label = <LabelWithTip help={control.help}>{control.label}</LabelWithTip>;
  if (control.kind === 'switch') {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1.5 }}>
        <Typography variant="body2">{label}</Typography>
        <Switch checked={control.value} onChange={(_, checked) => onValue(checked)} slotProps={{ input: { 'aria-label': control.label } }} />
      </Box>
    );
  }
  if (control.kind === 'slider') {
    return (
      <Box>
        <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
          <Typography variant="body2" component="span">{label}</Typography>
          <Typography variant="body2" component="span" sx={{ fontFamily: 'monospace' }}>
            {control.value.toFixed(control.decimals)}
          </Typography>
        </Box>
        <Slider
          size="small"
          aria-label={control.label}
          value={control.value}
          min={control.min}
          max={control.max}
          step={control.step}
          onChange={(_, value) => onValue(Array.isArray(value) ? value[0] : value)}
        />
      </Box>
    );
  }
  return (
    <Box>
      <Typography variant="body2" component="div" sx={{ mb: 0.5 }}>{label}</Typography>
      <PlainInput control={control} onValue={onValue} />
    </Box>
  );
}

function PlainInput({ control, onValue }: { control: Extract<ControlModel, { kind: 'number' | 'select' | 'text' }>; onValue: (raw: unknown) => void }) {
  const common = { size: 'small' as const, fullWidth: true, slotProps: { htmlInput: { 'aria-label': control.label } } };
  if (control.kind === 'select') {
    return (
      <TextField select {...common} value={control.value} onChange={(event) => onValue(event.target.value)}>
        {control.options.map((option) => (
          <MenuItem key={String(option.value)} value={option.value}>{option.label}</MenuItem>
        ))}
      </TextField>
    );
  }
  if (control.kind === 'text') {
    return (
      <TextField {...common} multiline minRows={2} value={control.value} placeholder={control.placeholder} onChange={(event) => onValue(event.target.value)} />
    );
  }
  return (
    <TextField
      {...common}
      type="number"
      value={control.value}
      slotProps={{ htmlInput: { 'aria-label': control.label, min: control.min, max: control.max, step: control.step } }}
      onChange={(event) => onValue(event.target.value)}
    />
  );
}

/**
 * Settings panel generated from a `ParamsSchema`: slider (bounded number), number input, switch, select and text,
 * each with an `InfoTip` when the field has help; advanced fields sit in a collapsible section. Use it inline as a
 * panel, or inside `SchemaParamsPopover`. The component is controlled: keep `values` in your state.
 */
export function SchemaParamsForm({ schema, values, onChange, titleId, children }: SchemaParamsFormProps) {
  useI18nVersion();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const { basic, advanced } = buildControls(schema, values, i18n.get);
  const change = (key: string) => (raw: unknown) => {
    const field = findField(schema, key);
    if (field) onChange({ [key]: coerceValue(field, raw) });
  };
  const rows = (controls: ControlModel[]) =>
    controls.map((control) => <ControlRow key={control.key} control={control} onValue={change(control.key)} />);
  return (
    <Box sx={{ display: 'grid', gap: 2 }}>
      {titleId && (
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography variant="overline" color="text.secondary">{i18n.get(titleId)}</Typography>
          <Button size="small" color="inherit" startIcon={<RestartAltIcon />} onClick={() => onChange(defaultValues(schema))}>
            {i18n.get('common.ui.schemaForm.reset')}
          </Button>
        </Box>
      )}
      {rows(basic)}
      {children}
      {advanced.length > 0 && (
        <Box sx={{ borderTop: 1, borderColor: 'divider', pt: 1.5 }}>
          <Button
            size="small"
            color="inherit"
            aria-expanded={showAdvanced}
            onClick={() => setShowAdvanced((open) => !open)}
            startIcon={<ExpandMoreIcon sx={{ transform: showAdvanced ? 'none' : 'rotate(-90deg)', transition: 'transform 120ms' }} />}
          >
            {i18n.get('common.ui.schemaForm.advanced')}
          </Button>
          <Collapse in={showAdvanced} unmountOnExit>
            <Box sx={{ display: 'grid', gap: 2, mt: 1.5 }}>{rows(advanced)}</Box>
          </Collapse>
        </Box>
      )}
    </Box>
  );
}
