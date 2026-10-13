/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useMemo } from 'react';
import { Box } from '@mui/material';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Tooltip,
  Legend,
} from 'chart.js';
import { Line } from 'react-chartjs-2';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, Tooltip, Legend);

export interface TrendChartSeries {
  label: string;
  data: number[];
  color?: string;
}

export interface TrendChartProps {
  labels: string[];
  series: TrendChartSeries[];
  height?: number;
}

const DEFAULT_COLORS = ['#F4B000', '#3B82F6', '#10B981', '#EF4444'];

/** Shared line chart (chart.js) for evolution over time; one line per series. */
export function TrendChart({ labels, series, height = 280 }: TrendChartProps): React.JSX.Element {
  const data = useMemo(
    () => ({
      labels,
      datasets: series.map((s: TrendChartSeries, i: number) => ({
        label: s.label,
        data: s.data,
        borderColor: s.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length],
        backgroundColor: (s.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length]) + '33',
        tension: 0.25,
        fill: false,
      })),
    }),
    [labels, series],
  );

  const options = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: series.length > 1 } },
      scales: { y: { beginAtZero: true } },
    }),
    [series.length],
  );

  return (
    <Box sx={{ height }}>
      <Line data={data} options={options} />
    </Box>
  );
}

export default TrendChart;
