/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, expect, it } from '@jest/globals';
import { remoteApiAuthHeaders } from './remoteApiAuth';

describe('remoteApiAuthHeaders', () => {
  it('prefers the scoped API key, sent as X-API-Key', () => {
    expect(remoteApiAuthHeaders({ REMOTE_API_KEY: ' ctd_k ', TECH_TOKEN: 'jwt' })).toEqual({ 'X-API-Key': 'ctd_k' });
  });

  it('falls back to the legacy tech token while the key is unset', () => {
    expect(remoteApiAuthHeaders({ TECH_TOKEN: 'jwt' })).toEqual({ Authorization: 'Bearer jwt' });
    expect(remoteApiAuthHeaders({ REMOTE_API_KEY: '  ', TECH_TOKEN: 'jwt' })).toEqual({ Authorization: 'Bearer jwt' });
  });

  it('sends nothing without any credential', () => {
    expect(remoteApiAuthHeaders({})).toEqual({});
  });
});
