/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { SetMetadata } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

/**
 * Extension points that let a module use capabilities of an OPTIONAL module without
 * importing it: `user` uses `infra` / `commerce`, public modules (`issue-report`)
 * use `user`.
 *
 * The consumer depends on these tokens/interfaces only (they live in `common`, which is
 * always present). The optional module provides the implementation under the token
 * (`{ provide: TOKEN, useExisting: RealService }`) and exports it from a global
 * scope; the consumer injects it with `@Optional() @Inject(TOKEN)` and degrades
 * gracefully when absent. This keeps the consumer compilable and bootable when the
 * provider's folder is not part of the project.
 */

/** Minimal key/value cache. Provided by `infra` (`CacheService`, Redis, noop without REDIS_URL). */
export const KEY_VALUE_CACHE = 'KEY_VALUE_CACHE';
export interface KeyValueCache {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSec?: number): Promise<void>;
  del(key: string): Promise<void>;
}

/** Business-level user gauges sink. Provided by `infra` (`PrometheusService`) when Prometheus is enabled. */
export const USER_METRICS_SINK = 'USER_METRICS_SINK';
export interface UserMetricsSink {
  updateUserCounts(totalUsers: number, activeUsers24h: number): void;
}

/**
 * Tells `user` whether a tier is sold. Provided by `commerce` (`ProductService`).
 * Absent => every tier is considered free (nothing is sold).
 */
export const TIER_PRICING_PROVIDER = 'TIER_PRICING_PROVIDER';
export interface TierPricingProvider {
  /** True when an active + recurring commerce Product grants this tier. */
  hasActiveRecurringProduct(tierId: number): Promise<boolean>;
}

/**
 * Health contributors aggregated by `GET /api/v1/health` (`common`). A module that knows how to probe something
 * (database, cache, an upstream API) provides one contributor, or an array of them, under this token
 * (`{ provide: HEALTH_CONTRIBUTORS, useExisting: MyContributor }`) and exports it from a global scope.
 * Absent => the endpoint only reports process liveness. Only one provider per project: a module that needs
 * several contributors provides an array.
 */
export const HEALTH_CONTRIBUTORS = 'HEALTH_CONTRIBUTORS';
export type HealthState = 'ok' | 'degraded' | 'down';
export interface HealthContribution {
  /** `down` makes the endpoint answer 503; `degraded` stays 200. */
  status: HealthState;
  [detail: string]: unknown;
}
export interface HealthContributor {
  /** Key under which the contribution appears in the `checks` object of the response. */
  readonly key: string;
  check(): Promise<HealthContribution> | HealthContribution;
}

/**
 * How to reach a user of the app: provided by `user` (`UserContactService`, global scope). Lets a public module
 * mail a user (e.g. `issue-report`: closure notice of a report) without importing the private `user` module and
 * without keeping its own copy of the address. Absent => no e-mail; the consumer says so once in the log.
 */
export const USER_CONTACT = 'USER_CONTACT';
export interface UserContactProvider {
  /** Address of an active account, `null` when there is none (unknown, deactivated or deleted account, empty address). */
  emailOf(userId: string | number): Promise<string | null>;
  /** Preferred language of the account (`fr`, `en`…), `null` when unknown. */
  localeOf?(userId: string | number): Promise<string | null>;
}

/**
 * Account erasure participants: any number of modules react to the closure of an account without `user` importing them (a public
 * module such as `interaction` forgets the account's channels, notices and tickets). Unlike the single-provider tokens above, this is
 * a LIST: each participant is a provider of its own module whose class carries `@AccountErasureParticipant()`; `user`
 * (`AccountErasureParticipants`) finds them through Nest's `DiscoveryService` at call time (never constructor-injected, so a
 * participant may depend on `UserService` without a DI cycle). Absent => nothing happens.
 *
 * Each call is isolated: a participant that throws is logged and traced, never blocks the other participants nor the closure (the
 * right to erasure). Both methods must be IDEMPOTENT: `onAccountErased` runs at the closure and again when the deep sweep reaches an
 * account closed earlier (`eraseClosedAccountIdentifiers`).
 */
export const ACCOUNT_ERASURE_PARTICIPANT = 'vx:account-erasure-participant';
export interface AccountErasureParticipant {
  /** Short stable name for the logs and traces (`interaction`): never a user value. */
  readonly erasureKey: string;
  /** Before the account row is anonymized (its e-mail still readable), after the legacy `ACCOUNT_DELETION_HOOK` of `user`. */
  beforeAccountDeletion?(userId: number): Promise<void>;
  /** After the account row is anonymized (the account is inactive), and for an account closed earlier when the deep sweep reaches it. */
  onAccountErased?(userId: number): Promise<void>;
  /**
   * The deep RGPD sweep of a CLOSED account (`user`: `UserAnonymizationService.anonymize`, run by the administrator's complete closure,
   * the RGPD dialog and the 5-year batch): the personal data the module still holds for it beyond what `onAccountErased` forgets (texts,
   * images, voice, identifiers…). Returns row counts by table (never a value), or nothing. Idempotent, called after `onAccountErased`.
   */
  sweepAccountData?(userId: number): Promise<Record<string, number> | void>;
}

/** Marks a provider class as an `AccountErasureParticipant` (it must implement the interface and be a singleton provider). */
export const AccountErasureParticipant = (): ClassDecorator => SetMetadata(ACCOUNT_ERASURE_PARTICIPANT, true);

/**
 * Account purge guards: the PHYSICAL deletion of an account row (`user`: `AccountPurgeService`, administrator, account already closed)
 * is refused while one of them reports records that must be kept (invoices, orders, payments… legal retention): a lasting state, the
 * account can only stay closed (`409 ACCOUNT_PURGE_RETAINED_RECORDS`). A temporary obstacle (something still running, to retry later)
 * is NOT a retention: it is a participant's `purgeBlockers` (`409 ACCOUNT_PURGE_BLOCKED`). A LIST found by discovery like the erasure
 * participants (`@AccountPurgeGuard()`), never constructor-injected. Absent => nothing is retained. A guard that throws refuses the
 * deletion (fail closed). The purge itself is OPT-IN per app (`user_accountPurgeEnabled`, off by default): see `user`'s README.
 */
export const ACCOUNT_PURGE_GUARD = 'vx:account-purge-guard';
export interface AccountPurgeGuard {
  /** Short stable name for the logs and traces (`commerce`): never a user value. */
  readonly purgeGuardKey: string;
  /** Records of the account that must be kept, counted by kind (`orders`, `invoices`…); every count 0 (or `{}`) lets the deletion go. */
  retainedRecords(userId: number, context?: AccountPurgeContext): Promise<Record<string, number>>;
}

/**
 * What `user` hands to EVERY account purge hook (guards and participants), as their last argument (2026-11-25, additive: a hook that
 * ignores it keeps working). The purge answers `202` once admitted and runs its irreversible part in the BACKGROUND: the HTTP request's
 * context (`currentRequest()`, its AsyncLocalStorage, `req.user`) does NOT exist inside `beforeAccountPurge`, `purgeAccountRows` and
 * `afterAccountPurge` — read who asked from here. Always given by `user`; optional in the signatures so a direct call (a spec) may omit it.
 */
export interface AccountPurgeContext {
  /** The administrator who asked for the purge (or its preview), in person. */
  readonly adminId: number;
}

/**
 * The failure contract of a purge hook (duck-typed, nothing to import): a hook that fails AFTER doing something irreversible outside the
 * database (files deleted, a remote machine cleaned…) throws an `Error` carrying `partial: true` and a stable `code` (`[A-Za-z0-9_.-]`,
 * 64 characters at most; its message is never shown nor logged). `user` then answers its usual code (`ACCOUNT_PURGE_PARTICIPANT_FAILED`,
 * `_RESIDUAL_ROWS`, `_FAILED`) with `details.partial = true`, and the administrator is told that the account is NOT deleted but that part of
 * its data outside the database is already erased (retry: a new proof is needed). `user` sets `partial` by itself once any
 * `beforeAccountPurge` has returned, whatever fails after it.
 */
export interface AccountPurgeHookFailure extends Error {
  readonly code: string;
  readonly partial?: boolean;
}

/** Marks a provider class as an `AccountPurgeGuard` (it must implement the interface and be a singleton provider). */
export const AccountPurgeGuard = (): ClassDecorator => SetMetadata(ACCOUNT_PURGE_GUARD, true);

/**
 * What the purge does with a column that holds an account id: `delete` the rows, `nullify` the column (an authorship or an assignment on
 * data that stays), or `ignore` it (not an account id, or a value the module purges itself and that the safety net must not touch).
 */
export type AccountPurgeColumnAction = 'delete' | 'nullify' | 'ignore';

/** A column of the app named by its table and database column name (`orders`, `owner_user_id`). */
export interface AccountPurgeColumnRule {
  table: string;
  column: string;
  action: AccountPurgeColumnAction;
}

/**
 * One line of a participant's purge preview (`AccountPurgeParticipant.purgePreview`): something the purge would delete, keep or cause,
 * worded by the module. `user` never interprets a line: the administrator's page shows the label
 * `user.admin.accountAction.preview.<purgeKey>.<key>` (in the app's locale; `{0}` = `count`) followed by `items` as plain text.
 * Counts are the norm; `items` are short names the module judges an administrator may already see (never an e-mail, a path, a secret):
 * shown as they are, capped by `user`, never logged nor traced.
 */
export interface AccountPurgePreviewLine {
  /** The label's key under the participant's own `purgeKey`: `[A-Za-z0-9_.-]`, 64 characters at most (a line with another key is dropped). */
  key: string;
  /** A count (non-negative integer) shown with the label. */
  count?: number;
  /** Short names listed after the label (at most 20 kept, 120 characters each). */
  items?: readonly string[];
}

/**
 * Account purge participants: modules that own data keyed by an account and must clean it when the account row is PHYSICALLY deleted
 * (`user`: `AccountPurgeService`). A LIST found by discovery (`@AccountPurgeParticipant()`), never constructor-injected. After them, the
 * purge's generic safety net deletes (NOT NULL) or nullifies (nullable) every remaining column that references the account (TypeORM
 * metadata: relations to the user entity, integer `*user_id` / `*_by` columns, plus `purgeColumnRules`), in ONE transaction with the
 * account row last, and checks that no row still holds the account id.
 *
 * Order of a purge: guards (`retainedRecords`) → `purgeBlockers` → the administrator's proof → `202`, then in the BACKGROUND: deep sweep →
 * `beforeAccountPurge` → the transaction (`purgeAccountRows`, safety net, account row) → `afterAccountPurge`. `purgePreview` is only read
 * by the preview. Every hook gets {@link AccountPurgeContext} last; a failure after irreversible work: {@link AccountPurgeHookFailure}.
 *
 * A shared module that owns tables keyed by an account ships its own `purgeColumnRules` (a participant with only rules is enough), so every
 * app linking it classifies them the same way (`interaction`, `mcp-access`, `commerce`).
 */
export const ACCOUNT_PURGE_PARTICIPANT = 'vx:account-purge-participant';
export interface AccountPurgeParticipant {
  /** Short stable name for the logs, traces and preview labels (`<module>`, e.g. `billing`): never a user value. */
  readonly purgeKey: string;
  /** How the safety net treats the module's columns (overrides its defaults, adds columns it cannot recognise by their name). */
  readonly purgeColumnRules?: readonly AccountPurgeColumnRule[];
  /**
   * BEFORE the transaction, for what lives outside the database (files, remote machines). Idempotent; throwing refuses the purge (the
   * account stays closed, nothing of the transaction runs). Runs in the background: no request context (use `context`). Returns counts by
   * kind, or nothing.
   */
  beforeAccountPurge?(userId: number, context?: AccountPurgeContext): Promise<Record<string, number> | void>;
  /** INSIDE the purge transaction, before the safety net: the module's own rows. Throwing rolls the whole purge back. Returns counts by table. */
  purgeAccountRows?(userId: number, manager: EntityManager, context?: AccountPurgeContext): Promise<Record<string, number> | void>;
  /**
   * What prevents the purge FOR NOW (an operation still running, a remote cleanup not finished…), counted by kind; read after the guards
   * and BEFORE the administrator's proof. Any count > 0 refuses the purge with `409 ACCOUNT_PURGE_BLOCKED` (`details.blockers`:
   * `{ '<purgeKey>.<kind>': n }`), a temporary state the administrator retries — never a legal retention (that is a guard's). Throwing
   * blocks too (fail closed: `<purgeKey>.unavailable`). Also reported by the preview. `{}` or zeros: nothing blocks.
   */
  purgeBlockers?(userId: number, context?: AccountPurgeContext): Promise<Record<string, number>>;
  /**
   * The preview (`GET /users/admin/:id/purge-preview`, administrator, nothing written): what the purge would do for this account, as
   * opaque lines (see {@link AccountPurgePreviewLine}). Read-only and side-effect free. Throwing leaves the module out of the preview
   * (reported as failed to the administrator), never refuses anything.
   */
  purgePreview?(userId: number, context?: AccountPurgeContext): Promise<readonly AccountPurgePreviewLine[]>;
  /**
   * AFTER the purge transaction committed (the account row is gone): follow-ups that need the deletion done (notify the people concerned,
   * refresh caches, publish live events…). Never undoes anything: a throw is logged and traced, the purge still succeeded. Returns counts
   * by kind, or nothing.
   */
  afterAccountPurge?(userId: number, context?: AccountPurgeContext): Promise<Record<string, number> | void>;
}

/** Marks a provider class as an `AccountPurgeParticipant` (it must implement the interface and be a singleton provider). */
export const AccountPurgeParticipant = (): ClassDecorator => SetMetadata(ACCOUNT_PURGE_PARTICIPANT, true);
