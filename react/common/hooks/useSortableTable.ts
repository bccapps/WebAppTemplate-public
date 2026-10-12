/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useCallback, useMemo, useState } from 'react';

export type SortDirection = 'asc' | 'desc';

export type SortConfig<K extends string = string> = {
  field: K;
  direction: SortDirection;
};

export type ColumnAccessor<T, K extends string = string> = {
  key: K;
  accessor?: (item: T) => string | number | null;
};

export type UseSortableTableReturn<T, K extends string = string> = {
  sortedItems: T[];
  sortConfig: SortConfig<K>;
  handleSort: (field: K) => void;
};

export const useSortableTable = <T, K extends string = string>(
  items: T[],
  columns: ColumnAccessor<T, K>[],
  defaultSort: SortConfig<K>,
): UseSortableTableReturn<T, K> => {
  const [sortConfig, setSortConfig] = useState<SortConfig<K>>(defaultSort);

  const handleSort = useCallback(
    (field: K) => {
      setSortConfig((prev) => ({
        field,
        direction: prev.field === field && prev.direction === 'asc' ? 'desc' : 'asc',
      }));
    },
    [],
  );

  const columnMap = useMemo(() => {
    const map = new Map<K, ColumnAccessor<T, K>>();
    columns.forEach((col) => map.set(col.key, col));
    return map;
  }, [columns]);

  const sortedItems = useMemo(() => {
    const col = columnMap.get(sortConfig.field);
    if (!col) return items;

    const multiplier = sortConfig.direction === 'asc' ? 1 : -1;
    const accessor = col.accessor ?? ((item: T) => (item as Record<string, unknown>)[col.key] as string | number | null);

    return [...items].sort((a, b) => {
      const valA = accessor(a);
      const valB = accessor(b);

      if (valA == null && valB == null) return 0;
      if (valA == null) return 1;
      if (valB == null) return -1;

      if (typeof valA === 'string' && typeof valB === 'string') {
        return valA.localeCompare(valB) * multiplier;
      }

      return ((valA as number) - (valB as number)) * multiplier;
    });
  }, [items, sortConfig, columnMap]);

  return { sortedItems, sortConfig, handleSort };
};
