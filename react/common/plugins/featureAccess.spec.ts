/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { afterEach, describe, it, expect } from 'vitest';
import { hasFeature, isFeatureGatingActive, registerFeatureChecker } from './featureAccess';

afterEach(() => registerFeatureChecker(null));

describe('featureAccess', () => {
  it('lets everything through while no checker is registered', () => {
    expect(isFeatureGatingActive()).toBe(false);
    expect(hasFeature('anything')).toBe(true);
  });

  it('delegates to the registered checker until it is removed', () => {
    registerFeatureChecker((id) => id === 'pro');
    expect(isFeatureGatingActive()).toBe(true);
    expect(hasFeature('pro')).toBe(true);
    expect(hasFeature('other')).toBe(false);
    registerFeatureChecker(null);
    expect(hasFeature('other')).toBe(true);
  });
});
