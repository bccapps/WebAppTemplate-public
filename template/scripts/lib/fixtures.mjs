/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/** Fixture libraries used by the project tests (module.json files only). */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const manifest = (id, over = {}) => ({
  id, title: id, description: `${id} module`, visibility: 'public', category: 'other', requires: [], env: [], questions: [], ...over,
});

/** Fixture libraries: public (common, database, voice) + private (user, commerce, infra, tenant, waitlist, llm). */
export function makeLibs() {
  const root = mkdtempSync(path.join(tmpdir(), 'engine-'));
  const put = (repo, stack, m) => {
    const dir = path.join(root, repo, stack, m.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'module.json'), JSON.stringify(m));
  };
  for (const stack of ['nest', 'react']) {
    put('public', stack, manifest('common'));
    put('public', stack, manifest('voice', { requires: ['common'], category: 'ai' }));
    put('private', stack, manifest('infra', { visibility: 'private', requires: ['common'], category: 'core' }));
    put('private', stack, manifest('commerce', { visibility: 'private', requires: stack === 'nest' ? ['common', 'user'] : ['user'], category: 'business' }));
    put('private', stack, manifest('llm', { visibility: 'private', requires: ['user'], category: 'ai' }));
  }
  put('public', 'nest', manifest('database'));
  put('private', 'react', manifest('waitlist', { visibility: 'private', requires: ['common'], category: 'users' }));
  put('private', 'nest', manifest('tenant', { visibility: 'private', requires: ['user'], category: 'users' }));
  put('private', 'nest', manifest('user', {
    visibility: 'private', category: 'users', requires: ['commerce', 'common', 'infra'], env: ['JWT_SECRET'],
    questions: [
      {
        id: 'authMethods', prompt: 'Login methods', type: 'multiselect', default: ['wallet', 'email'],
        options: ['wallet', 'email', 'social', 'openfort'].map((value) => ({ value })),
        effects: [
          { config: { name: 'user_authMethods', value: '$answer', exclude: ['openfort'] } },
          { when: { includes: 'email' }, config: { name: 'user_authEmailEnabled', value: true } },
          { when: { excludes: 'email' }, config: { name: 'user_authEmailEnabled', value: false } },
        ],
      },
      {
        id: 'authSocials', prompt: 'Socials', type: 'multiselect', default: ['google'], when: { question: 'authMethods', includes: 'social' },
        options: ['google', 'x'].map((value) => ({ value })), effects: [{ config: { name: 'user_authSocials', value: '$answer' } }],
      },
      {
        id: 'reownProjectId', prompt: 'Reown', type: 'text', default: '', when: { question: 'authMethods', includes: 'wallet' },
        effects: [{ env: { stack: 'front', name: 'VITE_REOWN_PROJECT_ID', value: '$answer' } }],
      },
      {
        id: 'registration', prompt: 'Sign-up', type: 'select', default: 'open', options: ['open', 'invitation', 'waitlist'].map((value) => ({ value })),
        effects: [
          { when: { equals: 'invitation' }, config: { name: 'user_registrationMode', value: 'invite-only' } },
          { when: { equals: 'waitlist' }, config: { name: 'user_registrationMode', value: 'manual' }, modules: ['waitlist'] },
        ],
      },
      { id: 'multiTenant', prompt: 'Tenants?', type: 'confirm', default: false, effects: [{ when: { equals: true }, modules: ['tenant'] }] },
    ],
  }));
  put('private', 'react', manifest('user', { visibility: 'private', category: 'users', requires: ['common'] }));
  // commerce question lives in the nest manifest of commerce
  put('private', 'nest', manifest('commerce', {
    visibility: 'private', requires: ['common', 'user'], category: 'business',
    questions: [{
      id: 'commerce', prompt: 'Selling?', type: 'confirm', default: false, alwaysAsk: true, requiresPrivate: true, requires: ['user'],
      effects: [
        { when: { equals: true }, configJson: { name: 'features', path: 'commerce.enabled', value: true } },
        { when: { equals: false }, configJson: { name: 'features', path: 'commerce.enabled', value: false } },
      ],
    }],
  }));
  return { root, pub: path.join(root, 'public'), priv: path.join(root, 'private'), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

