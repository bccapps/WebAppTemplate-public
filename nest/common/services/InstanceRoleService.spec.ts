/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { InstanceRoleService } from './InstanceRoleService';

describe('InstanceRoleService', () => {
  const original = process.env.NODE_ROLE;
  let log: jest.SpiedFunction<Logger['log']>;
  let warn: jest.SpiedFunction<Logger['warn']>;

  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (original === undefined) delete process.env.NODE_ROLE;
    else process.env.NODE_ROLE = original;
  });

  const make = (value: string | undefined): InstanceRoleService => {
    if (value === undefined) delete process.env.NODE_ROLE;
    else process.env.NODE_ROLE = value;
    return new InstanceRoleService();
  };

  it('api: HTTP only', () => {
    const s = make('api');
    expect([s.role, s.isApi(), s.isWorker()]).toEqual(['api', true, false]);
    expect(warn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('Instance role: api');
  });

  it('worker: background work', () => {
    const s = make('worker');
    expect([s.role, s.isApi(), s.isWorker()]).toEqual(['worker', false, true]);
    expect(warn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('Instance role: worker');
  });

  it('all: explicit single process, runs the background work, is not "api", no warning', () => {
    for (const value of ['all', ' ALL ']) {
      warn.mockClear();
      log.mockClear();
      const s = make(value);
      expect([s.role, s.isApi(), s.isWorker()]).toEqual(['all', false, true]);
      expect(warn).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith('Instance role: all (single process: API + background work)');
    }
  });

  it('unset or empty: worker behaviour, no warning', () => {
    for (const value of [undefined, '', '  ']) {
      warn.mockClear();
      const s = make(value);
      expect([s.role, s.isApi(), s.isWorker()]).toEqual(['worker', false, true]);
      expect(warn).not.toHaveBeenCalled();
    }
  });

  it('unknown value: worker with a "not recognised" warning', () => {
    const s = make('both');
    expect([s.role, s.isApi(), s.isWorker()]).toEqual(['worker', false, true]);
    expect(warn).toHaveBeenCalledWith('NODE_ROLE="both" not recognised — defaulting to "worker".');
  });
});
