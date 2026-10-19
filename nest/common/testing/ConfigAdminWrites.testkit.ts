/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { ModuleConfigSchema } from '../types/ModuleConfigSchema';
import { ConfigurationService } from '../services/ConfigurationService';
import { ModuleConfigRegistry } from '../services/ModuleConfigRegistry';
import { ModuleConfigService } from '../services/ModuleConfigService';

type Row = { id: number; name: string; value: string; description: string };

/** In-memory stand-in for the `config` table + the services built on it (shared by the admin write specs). */
export function buildConfigStack(schemas: ModuleConfigSchema[], initial: Array<Omit<Row, 'id'>>) {
  const rows: Row[] = initial.map((row, index) => ({ id: index + 1, ...row }));
  const repo = {
    find: async (): Promise<Row[]> => rows.map((row) => ({ ...row })),
    findOne: async ({ where }: { where: { name: string } }): Promise<Row | null> =>
      rows.find((row) => row.name === where.name) ?? null,
    create: (data: Omit<Row, 'id'>): Row => ({ id: 0, ...data }),
    save: jestFn(async (entity: Row): Promise<Row> => {
      const index = rows.findIndex((row) => row.name === entity.name);
      if (index >= 0) rows[index] = entity;
      else rows.push({ ...entity, id: rows.length + 1 });
      return entity;
    }),
  };
  const registry = new ModuleConfigRegistry();
  schemas.forEach((schema) => registry.register(JSON.parse(JSON.stringify(schema))));
  const mapper = { mapFromEntities: (entities: Row[]) => entities.map(({ name, value, description }) => ({ name, value, description })) };
  const config = new ConfigurationService(repo as never, mapper as never, registry);
  const crypt = {
    encryptForStorage: (value: string): string => `enc:${value}`,
    decryptFromStorage: (value: string): string => value.replace(/^enc:/, ''),
  };
  const moduleConfig = new ModuleConfigService(registry, {} as never, config, crypt as never);
  return { rows, repo, config, moduleConfig, valueOf: (name: string): string | undefined => rows.find((row) => row.name === name)?.value };
}

function jestFn<T extends (...args: never[]) => unknown>(impl: T): T & { calls: number } {
  const wrapper = ((...args: never[]) => {
    wrapper.calls += 1;
    return impl(...args);
  }) as T & { calls: number };
  wrapper.calls = 0;
  return wrapper;
}
