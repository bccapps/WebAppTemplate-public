/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { memo, useCallback, useEffect, useState } from 'react';
import { Box, Button, CircularProgress, Stack, Typography } from '@mui/material';
import { I18nLabel } from '../../common/components/ui/label/I18nLabel';
import { i18n } from '../../common/core/i18n/I18n';
import { issueReportApi } from '../services/IssueReportApi';
import type { IssueReportItem } from '../types';
import { toneOf } from '../utils/issueReportForm';
import '../styles/tokens.css';

type LoadState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; items: IssueReportItem[] };

const metaSx = { color: 'var(--issue-report-item-meta-fg)' };

function formatDate(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(i18n.getLang());
}

const IssueReportRow = memo(function IssueReportRow({ item }: { item: IssueReportItem }) {
  const tone = toneOf(item);
  return (
    <Box component="li" sx={{ listStyle: 'none', py: 1.25, borderBottom: '1px solid var(--issue-report-item-border)' }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline', justifyContent: 'space-between' }}>
        <Typography variant="body2" sx={{ fontWeight: 600, wordBreak: 'break-word' }}>
          <Box component="span" sx={{ ...metaSx, mr: 1 }}>
            <I18nLabel id="issueReport.mine.number" params={[item.number]} nolf />
          </Box>
          {item.title}
        </Typography>
        <Typography variant="caption" sx={{ color: `var(--issue-report-status-${tone}-fg)`, whiteSpace: 'nowrap', fontWeight: 600 }}>
          <I18nLabel id={`issueReport.status.${tone}`} nolf />
        </Typography>
      </Stack>
      <Typography variant="caption" sx={metaSx}>
        <I18nLabel id="issueReport.mine.sentOn" params={[formatDate(item.createdAt)]} nolf />
        {item.closedAt ? (
          <>
            {' · '}
            <I18nLabel id="issueReport.mine.closedOn" params={[formatDate(item.closedAt)]} nolf />
          </>
        ) : null}
      </Typography>
    </Box>
  );
});

/** The signed-in user's reports and their state, loaded when shown (newest first, 50 at most). */
export function MyIssueReports() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    issueReportApi
      .mine()
      .then((items) => {
        if (!cancelled) setState({ status: 'ready', items: Array.isArray(items) ? items : [] });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  if (state.status === 'loading') {
    return (
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', px: 3, py: 3 }}>
        <CircularProgress size={16} />
        <Typography variant="body2" sx={metaSx}>
          <I18nLabel id="issueReport.mine.loading" />
        </Typography>
      </Stack>
    );
  }
  if (state.status === 'error') {
    return (
      <Stack spacing={1} sx={{ px: 3, py: 3, alignItems: 'flex-start' }}>
        <Typography variant="body2">
          <I18nLabel id="issueReport.mine.error" />
        </Typography>
        <Button size="small" onClick={retry}>
          <I18nLabel id="issueReport.mine.retry" />
        </Button>
      </Stack>
    );
  }
  if (state.items.length === 0) {
    return (
      <Typography variant="body2" sx={{ ...metaSx, px: 3, py: 3 }}>
        <I18nLabel id="issueReport.mine.empty" />
      </Typography>
    );
  }
  return (
    <Box component="ul" sx={{ m: 0, px: 3, py: 1, maxHeight: 420, overflowY: 'auto' }}>
      {state.items.map((item) => (
        <IssueReportRow key={item.id} item={item} />
      ))}
    </Box>
  );
}

export default MyIssueReports;
