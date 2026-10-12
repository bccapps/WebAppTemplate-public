/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { ConfigurationService } from './ConfigurationService';

type Row = { name: string; value: string };

const build = (initial: Row[]) => {
  let rows = initial;
  let release: (() => void) | null = null;
  const find = jest.fn(async (): Promise<Row[]> => {
    if (release === null && gate) await new Promise<void>((resolve) => { release = resolve; });
    return rows;
  });
  let gate = false;
  const mapper = { mapFromEntities: (entities: Row[]) => entities };
  const service = new ConfigurationService({ find } as never, mapper as never, { getAllSchemas: () => [] } as never);
  return {
    service, find,
    /** Makes the next database read wait until `releaseQuery()`. */
    holdNextQuery: (next: Row[]): void => { gate = true; release = null; rows = next; },
    releaseQuery: (): void => { gate = false; release?.(); },
  };
};

describe('ConfigurationService cache reload', () => {
  it('keeps serving the previous values while a reload is in flight, instead of reading as empty', async () => {
    const { service, holdNextQuery, releaseQuery } = build([{ name: 'switch', value: 'true' }]);
    await service.getConfiguration();
    expect(service.get('switch')).toBe('true');
    holdNextQuery([{ name: 'switch', value: 'false' }]);
    (service as unknown as { cacheLoadedAt: number }).cacheLoadedAt = 0; // stale: next read reloads
    const reload = service.getConfiguration();
    await Promise.resolve();
    expect(service.get('switch')).toBe('true'); // used to be undefined here
    releaseQuery();
    await reload;
    expect(service.get('switch')).toBe('false');
  });

  it('shares one database query between concurrent reloads', async () => {
    const { service, find, holdNextQuery, releaseQuery } = build([{ name: 'a', value: '1' }]);
    holdNextQuery([{ name: 'a', value: '2' }]);
    const reads = [service.getConfiguration(), service.getConfiguration(), service.getConfiguration()];
    await Promise.resolve();
    releaseQuery();
    await Promise.all(reads);
    expect(find).toHaveBeenCalledTimes(1);
    expect(service.get('a')).toBe('2');
  });
});
