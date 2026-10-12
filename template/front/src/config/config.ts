/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Front config
// If there is no backend, do not forget to set the proxy port accordingly in package.json (3000 for front-only - 3001 for back)
// When locales are stored 'remote' they are stored in src/locales on the backend
// If locales are 'local', they must be stored in the 'public/locales'
// If configurationType is 'local', contract files (ABIs) must be stored in 'public/contracts'
export const Configuration: { [id: string]: string | number | boolean } = {
  // Configuration type : 'local' or 'remote'
  configurationType: 'remote',
  apiUrl: '/api',
  // Locale configuration (remote by default)
  localesLanguages: 'fr,en',
  localeDefault: 'fr',
  localesCategories: 'common,custom',
  localesLocation: 'remote',
  // Only read by the user module (ignored when "user" is not listed in shared-modules.json).
  serversideUsers: true,
};
