/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { ModuleMetadata, Type } from '@nestjs/common';
import { pushHostPatterns } from './pure/pushHosts';
import type { InteractionChannelProvider } from './types/providerTypes';
import type { InteractionAuditSink, InteractionDirectory, InteractionRealtimePort, InteractionSecretStore, InteractionStepUpPort, VapidKeySource } from './types/ports';

/** `InteractionModule.forRoot(options)` (04 §4.8). */
export interface InteractionModuleOptions {
  /** Mandatory: the app's adapter (active, admin, administrators, names, e-mail, language). */
  directory: Type<InteractionDirectory>;
  /**
   * Built-in providers; default `{ browser: true, telegram: true }`; `inapp` always. `email` / `webhook` are not
   * shipped by this lot (extension point: an app passes its own provider in `providers`).
   */
  builtIn?: { browser?: boolean; telegram?: boolean };
  /** The app's channel providers. */
  providers?: Type<InteractionChannelProvider>[];
  /** Modules the directory, the app's providers and ports depend on. */
  imports?: ModuleMetadata['imports'];
  ports?: {
    secretStore?: Type<InteractionSecretStore>;
    realtime?: Type<InteractionRealtimePort>;
    audit?: Type<InteractionAuditSink>;
    stepUp?: Type<InteractionStepUpPort>;
    vapidKeys?: Type<VapidKeySource>;
  };
  /** Default `{ user: true, admin: true, telegramWebhook: false }` (AgentHub, C2: façades of its own). */
  routes?: { user?: boolean; admin?: boolean; telegramWebhook?: boolean };
  /**
   * Background loops (expiry sweep, outcome retries, purge, Telegram polling) on worker processes. Default true;
   * tests turn them off and drive the services directly.
   */
  background?: boolean;
  /**
   * 04 §22: a provider declaring `proof: 'code'` (a one-time code typed in the channel) is refused at startup unless
   * this is true. Default false: not retained in v1, and even when allowed such a channel never answers a
   * `freshProof` question in v1 (only `in_app` channels do).
   */
  allowCodeProof?: boolean;
  /**
   * Review F8: hosts a Web Push endpoint may point at, IN ADDITION to the major browsers' push services
   * (`DEFAULT_PUSH_HOSTS`: FCM, Mozilla autopush, Windows WNS, Apple). `host.example` or `*.example` (subdomains).
   */
  pushHostAllowlist?: string[];
  /**
   * Review F8: accept an endpoint on ANY public host (the SSRF guard still applies). Default false. Such a host never
   * receives the VAPID `sub` contact of the app (a neutral one is used instead).
   */
  allowAnyPublicPushHost?: boolean;
}

/** The options once defaults are applied (injected as `INTERACTION_OPTIONS`). */
export interface InteractionRuntimeOptions {
  builtIn: { browser: boolean; telegram: boolean };
  routes: { user: boolean; admin: boolean; telegramWebhook: boolean };
  background: boolean;
  allowCodeProof: boolean;
  /** `DEFAULT_PUSH_HOSTS` + `pushHostAllowlist`, lower-cased. */
  pushHosts: string[];
  allowAnyPublicPushHost: boolean;
}

export function resolveInteractionOptions(options: InteractionModuleOptions): InteractionRuntimeOptions {
  return {
    builtIn: { browser: options.builtIn?.browser !== false, telegram: options.builtIn?.telegram !== false },
    routes: { user: options.routes?.user !== false, admin: options.routes?.admin !== false, telegramWebhook: options.routes?.telegramWebhook === true },
    background: options.background !== false,
    allowCodeProof: options.allowCodeProof === true,
    pushHosts: pushHostPatterns(options.pushHostAllowlist),
    allowAnyPublicPushHost: options.allowAnyPublicPushHost === true,
  };
}
