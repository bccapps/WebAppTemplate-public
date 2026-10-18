/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { SetMetadata } from '@nestjs/common';

export const API_SCOPE_KEY = 'apiScope';

/**
 * Opens a READ route to a service API key carrying `scope` (e.g. `tradingplatform:read`), in addition to its
 * normal user authentication. `GlobalAuthInterceptor` admits the key through the optional `SERVICE_KEY_AUTH`
 * provider (the `api-access` module): the request then carries `req.servicePrincipal` and NO `req.user`, so the
 * route must not depend on a user. Without the provider (module not linked) the decorator changes nothing.
 * Never put it on a write, per-user or admin route.
 */
export const ApiScope = (scope: string) => SetMetadata(API_SCOPE_KEY, scope);
