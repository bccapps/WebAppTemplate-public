/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Card, CardContent, Grid, Typography } from '@mui/material';
import { deltaColor, formatDelta } from '../../../utils/deltaFormat';

export interface KpiTileData {
  label: React.ReactNode;
  value: string;
  deltaPct?: number | null;
  deltaLabel?: string;
}

export interface KpiGridProps {
  tiles: KpiTileData[];
}

/** Small, pure KPI tile — no data fetching, just presentation. */
export function KpiTile({ label, value, deltaPct, deltaLabel }: KpiTileData): React.JSX.Element {
  return (
    <Card variant="outlined">
      <CardContent>
        <Typography variant="body2" color="text.secondary">{label}</Typography>
        <Typography variant="h5" sx={{ mt: 0.5 }}>{value}</Typography>
        {deltaPct !== undefined && (
          <Typography variant="caption" sx={{ color: deltaColor(deltaPct ?? null) }}>
            {formatDelta(deltaPct ?? null)} {deltaLabel}
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}

/** Responsive grid of {@link KpiTile}s. */
export function KpiGrid({ tiles }: KpiGridProps): React.JSX.Element {
  return (
    <Grid container spacing={2}>
      {tiles.map((tile: KpiTileData, i: number) => (
        <Grid key={i} size={{ xs: 6, sm: 4, md: 3 }}>
          <KpiTile {...tile} />
        </Grid>
      ))}
    </Grid>
  );
}

export default KpiGrid;
