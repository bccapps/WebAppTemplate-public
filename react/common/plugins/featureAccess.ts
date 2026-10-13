/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/** Answers "may the current visitor use feature `id`?". Registered by the `user` plugin (its feature/tier system). */
export type FeatureChecker = (featureId: string) => boolean;

let checker: FeatureChecker | null = null;

/**
 * Extension point of `RequireFeature` and of the menu `hasFeature`. Without a registered checker (no `user` module)
 * nothing is restricted: every feature is available. Pass `null` to unregister (tests).
 */
export function registerFeatureChecker(next: FeatureChecker | null): void {
  checker = next;
}

/** True while a feature system is registered. */
export function isFeatureGatingActive(): boolean {
  return checker !== null;
}

export function hasFeature(featureId: string): boolean {
  return checker ? checker(featureId) : true;
}
