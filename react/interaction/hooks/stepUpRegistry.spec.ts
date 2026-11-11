/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { interactionStepUpHandler, registerInteractionStepUp } from './interactionHooks';

describe('interactionStepUpHandler', () => {
  afterEach(() => registerInteractionStepUp(null));

  it('is the last registered step-up UI, null once withdrawn', () => {
    expect(interactionStepUpHandler()).toBeNull();
    const first = async () => 'proof-1';
    const second = async () => 'proof-2';
    registerInteractionStepUp(first);
    registerInteractionStepUp(second);
    expect(interactionStepUpHandler()).toBe(second);
    registerInteractionStepUp(null);
    expect(interactionStepUpHandler()).toBeNull();
  });
});
