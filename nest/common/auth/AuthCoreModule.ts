/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { DynamicModule, Global, Module, ModuleMetadata, Type } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AdminSessionController } from './AdminSessionController';
import { AnonymousAuthProvider } from './AnonymousAuthProvider';
import { AUTH_PORT, type AuthPort } from './AuthPort';
import { GlobalAuthInterceptor } from './GlobalAuthInterceptor';

export interface AuthCoreOptions {
  /** Modules that provide the dependencies of `provider`. */
  imports?: ModuleMetadata['imports'];
  /** Replaces the anonymous (ADMIN_TOKEN) provider, e.g. UserAuthProvider. */
  provider?: Type<AuthPort>;
}

@Global()
@Module({})
export class AuthCoreModule {
  static forRoot(opts: AuthCoreOptions = {}): DynamicModule {
    const provider = opts.provider ?? AnonymousAuthProvider;
    return {
      module: AuthCoreModule,
      imports: opts.imports ?? [],
      controllers: [AdminSessionController],
      providers: [
        provider,
        { provide: AUTH_PORT, useExisting: provider },
        GlobalAuthInterceptor,
        { provide: APP_INTERCEPTOR, useExisting: GlobalAuthInterceptor },
      ],
      exports: [AUTH_PORT],
    };
  }
}
