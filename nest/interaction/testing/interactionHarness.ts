/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Builds the module on a real database (SQLite in memory or a Postgres the caller provides) with the real services,
// controllers and auth interceptors, the fakes of `interactionFakes.ts` for the network, and log capture. Used by the
// conformance testkit (04 §17). Set `DB_ENGINE` BEFORE importing this file (entity column types are read at import).

import { INestApplication, Logger, type LoggerService, type Provider, type Type } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { inspect } from 'util';
import { AuthCoreModule } from '../../common/auth/AuthCoreModule';
import type { AuthPrincipal } from '../../common/auth/AuthPrincipal';
import { EventStreamService } from '../../common/event-stream/EventStreamService';
import type { StreamFrame } from '../../common/event-stream/types';
import { AppExceptionFilter } from '../../common/exceptions/AppExceptionFilter';
import { BrandService } from '../../common/services/BrandService';
import { ConfigurationService } from '../../common/services/ConfigurationService';
import { CronLockService } from '../../common/services/CronLockService';
import { CryptService } from '../../common/services/CryptService';
import { InstanceRoleService } from '../../common/services/InstanceRoleService';
import { LocaleService } from '../../common/services/LocaleService';
import { ModuleConfigService } from '../../common/services/ModuleConfigService';
import { ProwlService } from '../../common/services/ProwlService';
import { RedisService } from '../../common/services/RedisService';
import { interactionControllers, interactionProviders } from '../InteractionModule';
import { INTERACTION_ENTITIES } from '../interactionEntities';
import type { InteractionModuleOptions } from '../interactionOptions';
import { WebPushSender } from '../providers/browser/WebPushSender';
import { TelegramBotClient } from '../providers/telegram/TelegramBotClient';
import type { InteractionStepUpPort } from '../types/ports';
import type { InteractionChannelProvider } from '../types/providerTypes';
import {
  FakeTelegramBotClient,
  FakeWebPushSender,
  TestAuthPort,
  TestBrand,
  TestConfiguration,
  TestCronLock,
  TestDirectory,
  TestInstanceRole,
  TestLocales,
  TestModuleConfig,
} from './interactionFakes';

/** A 32-byte test master key (hex). Never a real one. */
export const TEST_MASTER_KEY = '0f'.repeat(32);

/** SQLite in memory, a SQLite file (to « restart » on the same data), or a Postgres schema. */
export type HarnessDatabase = { type: 'sqlite'; file?: string } | { type: 'postgres'; url: string; schema: string };

export interface HarnessOptions {
  database: HarnessDatabase;
  /** `interaction_*` values (defaults: the schema's). */
  config?: Record<string, unknown>;
  stepUp?: Type<InteractionStepUpPort>;
  providers?: Type<InteractionChannelProvider>[];
  /** Keep the tables of a previous harness (a « restart » on the same database). */
  keepData?: boolean;
  routes?: InteractionModuleOptions['routes'];
  /** Postgres only: size of the connection pool (`pg` default 10). The concurrency tests use it to race on several connections. */
  poolSize?: number;
  /** The REAL `TelegramBotClient` (its `fetch` mocked by the test) instead of the in-memory Bot API (`harness.telegram` then unused). */
  realTelegramClient?: boolean;
  /** A `WebPushSender` of the test (e.g. the real one with a fake `web-push` library) instead of `FakeWebPushSender`. */
  webPushSender?: WebPushSender;
  /** `forRoot({ allowCodeProof })`. */
  allowCodeProof?: boolean;
  /** `forRoot({ pushHostAllowlist })`; default: the host of the fakes' endpoints (`push.example.test`). */
  pushHostAllowlist?: string[];
  /** `forRoot({ allowAnyPublicPushHost })`. */
  allowAnyPublicPushHost?: boolean;
}

export interface Harness {
  app: INestApplication;
  module: TestingModule;
  dataSource: DataSource;
  directory: TestDirectory;
  telegram: FakeTelegramBotClient;
  push: FakeWebPushSender;
  config: TestModuleConfig;
  brand: TestBrand;
  events: EventStreamService;
  /** Every log line written while the harness is alive (to search for leaked targets). */
  logs: string[];
  get<T>(type: Type<T> | symbol): T;
  /** Opens an event-stream connection for a principal and collects its frames. */
  listen(principal: AuthPrincipal): Promise<StreamFrame[]>;
  close(): Promise<void>;
}

/**
 * A logged argument as a leak search must see it: `util.inspect` of every non-string (an error's own properties
 * included, e.g. the `query` and `parameters` of a TypeORM `QueryFailedError`, which `String()` and `JSON.stringify` hide).
 */
export function inspectPart(part: unknown): string {
  return typeof part === 'string' ? part : inspect(part, { depth: 8, breakLength: Infinity, showHidden: false });
}

class CapturingLogger implements LoggerService {
  constructor(private readonly lines: string[]) {}
  private push(level: string, message: unknown, ...rest: unknown[]): void {
    this.lines.push(`${level} ${[message, ...rest].map(inspectPart).join(' ')}`);
  }
  log(message: unknown, ...rest: unknown[]): void {
    this.push('log', message, ...rest);
  }
  error(message: unknown, ...rest: unknown[]): void {
    this.push('error', message, ...rest);
  }
  warn(message: unknown, ...rest: unknown[]): void {
    this.push('warn', message, ...rest);
  }
  debug(message: unknown, ...rest: unknown[]): void {
    this.push('debug', message, ...rest);
  }
  verbose(message: unknown, ...rest: unknown[]): void {
    this.push('verbose', message, ...rest);
  }
}

/** Console output (the common exception filter writes there) goes to `logs` too, until the harness closes. */
function captureConsole(lines: string[]): () => void {
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const saved = methods.map((name) => [name, console[name]] as const);
  for (const name of methods) console[name] = (...parts: unknown[]) => void lines.push(`console.${name} ${parts.map(inspectPart).join(' ')}`);
  return () => {
    for (const [name, original] of saved) console[name] = original;
  };
}

/** `CREATE SCHEMA IF NOT EXISTS` on the throwaway Postgres of the tests. */
async function ensureSchema(url: string, schema: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('invalid test schema name');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Client } = require('pg') as typeof import('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  } finally {
    await client.end();
  }
}

function databaseModule(database: HarnessDatabase, keepData: boolean, poolSize?: number) {
  if (database.type === 'sqlite') return TypeOrmModule.forRoot({ type: 'better-sqlite3', database: database.file ?? ':memory:', entities: INTERACTION_ENTITIES, synchronize: true, dropSchema: !keepData && database.file !== undefined });
  return TypeOrmModule.forRoot({ type: 'postgres', url: database.url, schema: database.schema, entities: INTERACTION_ENTITIES, synchronize: true, dropSchema: !keepData, ...(poolSize ? { extra: { max: poolSize } } : {}) });
}

/** What `trackPoolUsage` measures: the most connections checked out of the Postgres pool at the same time. */
export interface PoolUsage {
  /** Highest number of connections in use at once since the last `reset()`. */
  peak(): number;
  reset(): void;
  stop(): void;
}

/**
 * Counts the connections of the `pg` pool of a Postgres data source that are checked out at the same time, to PROVE a
 * test raced on several connections (a single-connection engine can never get past 1). TypeORM obtains its connections
 * with `pool.connect(callback)`; the callback and the `release` function are wrapped.
 */
export function trackPoolUsage(dataSource: DataSource): PoolUsage {
  const pool = (dataSource.driver as unknown as { master?: { connect: (...args: unknown[]) => unknown } }).master;
  if (!pool) throw new Error('trackPoolUsage needs a Postgres data source');
  const original = pool.connect;
  let inUse = 0;
  let peak = 0;
  pool.connect = function (this: unknown, ...args: unknown[]): unknown {
    const callback = args[args.length - 1];
    if (typeof callback !== 'function') return original.apply(this, args);
    const wrapped = (error: unknown, client: unknown, release: (...rest: unknown[]) => void): void => {
      if (error) return callback(error, client, release);
      inUse += 1;
      peak = Math.max(peak, inUse);
      let released = false;
      callback(error, client, (...rest: unknown[]) => {
        if (!released) inUse -= 1;
        released = true;
        release(...rest);
      });
    };
    return original.apply(this, [...args.slice(0, -1), wrapped]);
  };
  return {
    peak: () => peak,
    reset: () => {
      peak = inUse;
    },
    stop: () => {
      pool.connect = original;
    },
  };
}

/** A harness on a fresh (or kept) database. Call `close()` in `afterEach` / `afterAll`. */
export async function createInteractionHarness(options: HarnessOptions): Promise<Harness> {
  process.env.CRYPT_DB_MASTER_KEY ??= TEST_MASTER_KEY;
  if (options.database.type === 'postgres') await ensureSchema(options.database.url, options.database.schema);
  const logs: string[] = [];
  Logger.overrideLogger(new CapturingLogger(logs));
  const restoreConsole = captureConsole(logs);
  const config = new TestModuleConfig();
  for (const [key, value] of Object.entries(options.config ?? {})) config.values.set(key, value);
  const directory = new TestDirectory();
  const telegram = new FakeTelegramBotClient();
  const push = new FakeWebPushSender();
  const brand = new TestBrand();
  const moduleOptions: InteractionModuleOptions = {
    directory: TestDirectory,
    background: false,
    providers: options.providers,
    routes: options.routes ?? { user: true, admin: true, telegramWebhook: true },
    ports: options.stepUp ? { stepUp: options.stepUp } : undefined,
    allowCodeProof: options.allowCodeProof,
    pushHostAllowlist: options.pushHostAllowlist ?? ['push.example.test'],
    allowAnyPublicPushHost: options.allowAnyPublicPushHost,
  };
  const stubs: Provider[] = [
    { provide: ModuleConfigService, useValue: config },
    { provide: ConfigurationService, useValue: new TestConfiguration(config) },
    { provide: LocaleService, useValue: new TestLocales() },
    { provide: BrandService, useValue: brand },
    { provide: CronLockService, useValue: new TestCronLock() },
    { provide: InstanceRoleService, useValue: new TestInstanceRole() },
    { provide: RedisService, useValue: { getClient: () => null } },
    CryptService,
    EventStreamService,
  ];
  const builder = Test.createTestingModule({
    imports: [databaseModule(options.database, options.keepData === true, options.poolSize), TypeOrmModule.forFeature(INTERACTION_ENTITIES), AuthCoreModule.forRoot({ provider: TestAuthPort })],
    controllers: interactionControllers(moduleOptions),
    providers: [...interactionProviders(moduleOptions), ...stubs],
  })
    .overrideProvider(TestDirectory)
    .useValue(directory)
    .overrideProvider(WebPushSender)
    .useValue(options.webPushSender ?? push);
  if (!options.realTelegramClient) builder.overrideProvider(TelegramBotClient).useValue(telegram);
  const module = await builder.compile();
  module.useLogger(new CapturingLogger(logs));
  const app = module.createNestApplication({ logger: new CapturingLogger(logs) });
  app.useGlobalFilters(new AppExceptionFilter({ safeNotify: () => undefined } as unknown as ProwlService));
  await app.init();
  const events = module.get(EventStreamService);
  const dataSource = module.get(DataSource);
  return {
    app,
    module,
    dataSource,
    directory,
    telegram,
    push,
    config,
    brand,
    events,
    logs,
    get: <T>(type: Type<T> | symbol): T => module.get<T>(type as Type<T>),
    listen: async (principal: AuthPrincipal): Promise<StreamFrame[]> => {
      const frames: StreamFrame[] = [];
      await events.openConnection(principal, ['interaction.inbox'], { send: (frame) => frames.push(frame), end: () => undefined });
      return frames;
    },
    close: async () => {
      await app.close();
      restoreConsole();
    },
  };
}
