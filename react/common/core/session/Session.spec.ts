/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, it, expect } from 'vitest';
import Session from './Session';

/** Session whose `key` listener counts its calls. */
const watched = (key: string): { session: Session; calls: () => number } => {
  const session = new Session();
  let count = 0;
  session.addEventListener(key, () => { count += 1; });
  return { session, calls: () => count };
};

describe('Session.set', () => {
  it('notifies on the first write and on every real change', () => {
    const { session, calls } = watched('user');
    session.set('user', { id: 1 });
    session.set('user', { id: 2 });
    expect(calls()).toBe(2);
    expect(session.get('user')).toEqual({ id: 2 });
  });

  it('does not notify when an equal value is set again', () => {
    const { session, calls } = watched('user');
    session.set('user', { id: 1, tiers: [1, 2] });
    session.set('user', { id: 1, tiers: [1, 2] });
    session.set('lang', 'fr');
    expect(calls()).toBe(1);
  });

  it('still notifies for an object mutated in place and set again', () => {
    const { session, calls } = watched('user');
    const user: { id: number; name?: string } = { id: 1 };
    session.set('user', user);
    user.name = 'renamed';
    session.set('user', user);
    expect(calls()).toBe(2);
  });

  it('always notifies with force (option or force())', () => {
    const { session, calls } = watched('user');
    session.set('user', { id: 1 });
    session.set('user', { id: 1 }, { force: true });
    session.force('user');
    expect(calls()).toBe(3);
  });

  it('always notifies for values JSON cannot describe', () => {
    const { session, calls } = watched('map');
    session.set('map', new Map([['a', 1]]));
    session.set('map', new Map([['a', 1]]));
    expect(calls()).toBe(2);
  });

  it('treats null as a value: a second null is a no-op, a value after it notifies', () => {
    const { session, calls } = watched('user');
    session.set('user', null);
    session.set('user', null);
    session.set('user', { id: 1 });
    expect(calls()).toBe(2);
  });
});
