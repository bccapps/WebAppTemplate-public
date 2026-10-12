/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
// Jest setup: provide the env vars some shared modules require at import time
// (e.g. CryptService instantiated by EncryptedColumnTransformer at module load).
process.env.CRYPT_DB_MASTER_KEY =
  process.env.CRYPT_DB_MASTER_KEY ?? Buffer.alloc(32, 7).toString('base64');
