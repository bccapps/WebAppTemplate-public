/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { Table, TableBody, TableCell, TableHead, TableRow, TableSortLabel } from '@mui/material';
import { useSortableTable, type ColumnAccessor } from '../../common/hooks/useSortableTable';
import { useInteractionAdminChannels, useInteractionChannels, useInteractionPrefs } from '../hooks/interactionHooks';
import { ixLabel } from '../services/labels';
import type { InteractionCategory, InteractionChannelAdminDto, InteractionPrefBody } from '../types/interactionTypes';
import { BrowserChannelCard, TelegramChannelCard } from './channels/BuiltInChannelCards';
import { ChannelCardFrame } from './channels/ChannelCardFrame';
import { channelCardFor } from './channelCardRegistry';
import { IxLabel } from './IxText';
import '../styles/tokens.css';
import '../styles/interaction.css';

/** The user's channels (04 §10.2): `inapp` always on, then one card per kind the app offers. */
export function InteractionChannelsPanel() {
  const api = useInteractionChannels();
  if (api.loading) return <p className="ix-muted"><IxLabel id="interaction.channels.loading" /></p>;
  return (
    <section className="ix-panel" aria-labelledby="ix-channels-title">
      <h3 id="ix-channels-title"><IxLabel id="interaction.channels.title" /></h3>
      {api.channels.map((channel) => {
        if (channel.kind === 'inapp') {
          return (
            <article key="inapp" className="ix-channel-card">
              <header className="ix-channel-card-header">
                <h4><IxLabel id="interaction.channels.inapp.title" /></h4>
                <span className="ix-channel-state ix-channel-state--ok"><IxLabel id="interaction.channels.state.alwaysOn" /></span>
              </header>
              <p className="ix-muted"><IxLabel id="interaction.channels.inapp.help" /></p>
            </article>
          );
        }
        const Custom = channelCardFor(channel.kind);
        if (Custom) return <Custom key={channel.kind} channel={channel} onChanged={api.refetch} />;
        if (channel.kind === 'browser') return <BrowserChannelCard key={channel.kind} channel={channel} api={api} />;
        if (channel.kind === 'telegram') return <TelegramChannelCard key={channel.kind} channel={channel} api={api} />;
        return <ChannelCardFrame key={channel.kind} channel={channel} actions={api} />;
      })}
      {api.error ? <p className="ix-modal-error" role="alert"><IxLabel id={`interaction.errors.${api.error}`} /></p> : null}
    </section>
  );
}

const CATEGORIES: InteractionCategory[] = ['security', 'approval', 'info'];

/** Quiet hours, time zone, critical bypass, routing per category (approval / security: at least one), in-app display. */
export function InteractionPrefsPanel() {
  const { prefs, save, error } = useInteractionPrefs();
  const { channels } = useInteractionChannels();
  const [draft, setDraft] = useState<InteractionPrefBody | null>(null);
  const [saving, setSaving] = useState(false);
  const [missing, setMissing] = useState<InteractionCategory | null>(null);
  useEffect(() => {
    if (prefs && !draft) setDraft({ quietHours: prefs.quietHours, timezone: prefs.timezone, criticalBypass: prefs.criticalBypass, routing: prefs.routing, inappDisplay: prefs.inappDisplay });
  }, [prefs, draft]);
  if (!prefs || !draft) return null;
  const kinds = channels.filter((channel) => channel.kind !== 'inapp').map((channel) => channel.kind);
  const routeOf = (category: InteractionCategory): string[] | null => draft.routing?.[category] ?? null;
  const toggle = (category: InteractionCategory, kind: string, on: boolean) => {
    const current = routeOf(category) ?? kinds;
    const next = on ? [...new Set([...current, kind])] : current.filter((k) => k !== kind);
    setDraft({ ...draft, routing: { ...draft.routing, [category]: next } });
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const empty = CATEGORIES.find((category) => category !== 'info' && (routeOf(category) ?? kinds).length === 0 && kinds.length > 0);
    setMissing(empty ?? null);
    if (empty) return;
    setSaving(true);
    await save(draft);
    setSaving(false);
  };
  return (
    <form className="ix-panel ix-form" onSubmit={(event) => void submit(event)} aria-busy={saving}>
      <h3><IxLabel id="interaction.prefs.title" /></h3>
      <fieldset disabled={saving}>
        <label className="ix-switch">
          <input type="checkbox" checked={draft.quietHours != null} onChange={(event) => setDraft({ ...draft, quietHours: event.target.checked ? { start: '22:00', end: '07:00' } : null })} />
          <IxLabel id="interaction.prefs.quietHours" />
        </label>
        {draft.quietHours ? (
          <div className="ix-row">
            <label className="ix-field"><span><IxLabel id="interaction.prefs.from" /> *</span><input type="time" required value={draft.quietHours.start} onChange={(event) => setDraft({ ...draft, quietHours: { ...draft.quietHours!, start: event.target.value } })} /></label>
            <label className="ix-field"><span><IxLabel id="interaction.prefs.to" /> *</span><input type="time" required value={draft.quietHours.end} onChange={(event) => setDraft({ ...draft, quietHours: { ...draft.quietHours!, end: event.target.value } })} /></label>
          </div>
        ) : null}
        <label className="ix-field"><span><IxLabel id="interaction.prefs.timezone" /></span><input type="text" value={draft.timezone ?? ''} onChange={(event) => setDraft({ ...draft, timezone: event.target.value || null })} /></label>
        <label className="ix-switch">
          <input type="checkbox" checked={draft.criticalBypass !== false} onChange={(event) => setDraft({ ...draft, criticalBypass: event.target.checked })} />
          <IxLabel id="interaction.prefs.criticalBypass" />
        </label>
        <p className="ix-muted"><IxLabel id="interaction.prefs.quietHelp" /></p>
        {kinds.length > 0 ? (
          <table className="ix-table">
            <thead>
              <tr><th><IxLabel id="interaction.prefs.routing" /></th>{kinds.map((kind) => <th key={kind}><IxLabel id={`interaction.channels.${kind}.title`} /></th>)}</tr>
            </thead>
            <tbody>
              {CATEGORIES.map((category) => (
                <tr key={category}>
                  <th><IxLabel id={`interaction.categories.${category}`} />{category !== 'info' ? ' *' : null}</th>
                  {kinds.map((kind) => (
                    <td key={kind}><input type="checkbox" aria-label={ixLabel(`interaction.channels.${kind}.title`)} checked={(routeOf(category) ?? kinds).includes(kind)} onChange={(event) => toggle(category, kind, event.target.checked)} /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        <label className="ix-field">
          <span><IxLabel id="interaction.prefs.display" /></span>
          <select value={draft.inappDisplay ?? ''} onChange={(event) => setDraft({ ...draft, inappDisplay: event.target.value === 'toast' || event.target.value === 'browser' ? event.target.value : null })}>
            <option value="">{ixLabel('interaction.prefs.display.default')}</option>
            <option value="toast">{ixLabel('interaction.prefs.display.toast')}</option>
            <option value="browser">{ixLabel('interaction.prefs.display.browser')}</option>
          </select>
        </label>
      </fieldset>
      <button type="submit" className="ix-action ix-action--primary" disabled={saving}><IxLabel id={saving ? 'interaction.channels.saving' : 'interaction.channels.save'} /></button>
      {missing ? <p className="ix-modal-error" role="alert"><IxLabel id="interaction.errors.ROUTE_REQUIRED" /></p> : null}
      {error ? <p className="ix-modal-error" role="alert"><IxLabel id={`interaction.errors.${error}`} /></p> : null}
    </form>
  );
}

type AdminColumn = 'kind' | 'owner' | 'state' | 'verified' | 'lastTest' | 'lastError';

const ADMIN_COLUMNS: ColumnAccessor<InteractionChannelAdminDto, AdminColumn>[] = [
  { key: 'kind', accessor: (row) => row.kind },
  { key: 'owner', accessor: (row) => row.owner.name ?? String(row.owner.userId) },
  { key: 'state', accessor: (row) => (row.adminDisabled ? 0 : row.enabled ? 2 : 1) },
  { key: 'verified', accessor: (row) => (row.verified ? 1 : 0) },
  { key: 'lastTest', accessor: (row) => row.lastTestAt ?? '' },
  { key: 'lastError', accessor: (row) => row.lastError ?? '' },
];

/** Administrators: every user's channels (metadata only, never a target) and the `adminDisabled` switch. */
export function InteractionChannelsAdminPanel() {
  const { rows, loading, error, setAdminDisabled } = useInteractionAdminChannels();
  const table = useSortableTable<InteractionChannelAdminDto, AdminColumn>(rows, ADMIN_COLUMNS, { field: 'owner', direction: 'asc' });
  if (loading) return <p className="ix-muted"><IxLabel id="interaction.channels.loading" /></p>;
  return (
    <section className="ix-panel" aria-labelledby="ix-admin-title">
      <h3 id="ix-admin-title"><IxLabel id="interaction.admin.title" /></h3>
      <Table size="small" className="ix-table">
        <TableHead>
          <TableRow>
            {ADMIN_COLUMNS.map((column) => (
              <TableCell key={column.key}>
                <TableSortLabel active={table.sortConfig.field === column.key} direction={table.sortConfig.field === column.key ? table.sortConfig.direction : 'asc'} onClick={() => table.handleSort(column.key)}>
                  <IxLabel id={`interaction.admin.columns.${column.key}`} />
                </TableSortLabel>
              </TableCell>
            ))}
            <TableCell><IxLabel id="interaction.admin.columns.actions" /></TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {table.sortedItems.map((row) => (
            <TableRow key={row.id}>
              <TableCell><IxLabel id={`interaction.channels.${row.kind}.title`} /></TableCell>
              <TableCell>{row.owner.name ?? `#${row.owner.userId}`}</TableCell>
              <TableCell><IxLabel id={row.adminDisabled ? 'interaction.channels.state.adminDisabled' : row.enabled ? 'interaction.channels.state.on' : 'interaction.channels.state.disabled'} /></TableCell>
              <TableCell><IxLabel id={row.verified ? 'interaction.admin.yes' : 'interaction.admin.no'} /></TableCell>
              <TableCell>{row.lastTestAt ? `${new Date(row.lastTestAt).toLocaleString()} (${row.lastTestStatus ?? ''})` : '—'}</TableCell>
              <TableCell>{row.lastError ?? '—'}</TableCell>
              <TableCell>
                <button type="button" className="ix-link-button" onClick={() => void setAdminDisabled(row.owner.userId, row.kind, !row.adminDisabled)}>
                  <IxLabel id={row.adminDisabled ? 'interaction.admin.enable' : 'interaction.admin.disable'} />
                </button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {rows.length === 0 ? <p className="ix-muted"><IxLabel id="interaction.admin.empty" /></p> : null}
      {error ? <p className="ix-modal-error" role="alert"><IxLabel id={`interaction.errors.${error}`} /></p> : null}
    </section>
  );
}
