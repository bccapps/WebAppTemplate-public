/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * Registers every database connection (the "main"/default one plus any
 * additional named connections declared via env) on the NestJS container.
 *
 * Replaces the per-project inline `TypeOrmModule.forRootAsync({...})` block.
 * When no extra connection is configured it registers exactly one default
 * connection backed by the project's existing `AppDataSource` — behaviour is
 * strictly identical to the legacy single-DataSource wiring.
 */

import { DynamicModule, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DbContext, buildExtraDataSourceOptions } from './databases';
import { prepareSchema } from './schemaPreflight';

export interface DatabaseModuleOptions {
  /** Project-specific entity/migration locations. */
  context: DbContext;
  /**
   * The project's main DataSource — the same instance exported for the TypeORM
   * CLI/migrations, reused here so a single connection is initialised once.
   */
  mainDataSource: DataSource;
}

@Module({})
export class DatabaseModule {
  static forRoot(options: DatabaseModuleOptions): DynamicModule {
    const { context, mainDataSource } = options;

    const mainImport = TypeOrmModule.forRootAsync({
      useFactory: () => ({ ...mainDataSource.options }),
      dataSourceFactory: async () => {
        if (!mainDataSource.isInitialized) {
          await prepareSchema(mainDataSource.options, context);
          await mainDataSource.initialize();
        }
        return mainDataSource;
      },
    });

    const extraImports = buildExtraDataSourceOptions(context).map(
      ({ name, options: dsOptions }) =>
        TypeOrmModule.forRootAsync({
          name,
          useFactory: () => dsOptions,
          dataSourceFactory: async () => {
            const dataSource = new DataSource(dsOptions);
            if (!dataSource.isInitialized) {
              await prepareSchema(dsOptions, context);
              await dataSource.initialize();
            }
            return dataSource;
          },
        })
    );

    return {
      module: DatabaseModule,
      imports: [mainImport, ...extraImports],
      exports: [TypeOrmModule],
    };
  }
}
