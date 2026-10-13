/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, it, expect } from 'vitest';
import { tipIconButtonSx } from './tipIconButtonStyle';

describe('tipIconButtonSx', () => {
  it('gives the default tone a border and the danger tone a red hover', () => {
    expect(tipIconButtonSx('default', false)).toMatchObject({ border: 1 });
    expect(tipIconButtonSx('danger', false)['&:hover']).toMatchObject({ color: 'error.main' });
  });

  it('adds the selected look only when active', () => {
    expect(tipIconButtonSx('ghost', false)).not.toHaveProperty('bgcolor');
    expect(tipIconButtonSx('ghost', true)).toMatchObject({ bgcolor: 'action.selected' });
  });
});
