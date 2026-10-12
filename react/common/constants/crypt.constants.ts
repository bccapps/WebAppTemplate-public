/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

export const STORAGE_PAYLOAD_VERSION = 'v1';
/**
 * Transport payload format version. Bumped to v2 to add a compression flag
 * segment (see PERFORMANCE_PLAN.md §2.3 — compress-then-encrypt). v1 (4
 * segments, no flag, never compressed) is still fully supported on decrypt —
 * both here and on the nestcommon counterpart — so this bundle keeps working
 * against a backend that hasn't rolled out v2 yet, and a backend already on
 * v2 keeps working against a copy of this bundle served from the browser
 * cache from before this change.
 */
export const TRANSPORT_PAYLOAD_VERSION = 'v2';
export const TRANSPORT_PAYLOAD_VERSION_LEGACY = 'v1';
export const TRANSPORT_PAYLOAD_SEPARATOR = ':';
export const TRANSPORT_SESSION_HEADER = 'x-crypt-session';
export const TRANSPORT_VERSION_HEADER = 'x-crypt-version';
export const TRANSPORT_ENCRYPTED_HEADER = 'x-crypt-encrypted';
export const TRANSPORT_SESSION_SALT = 'web3c:transport-salt';
export const TRANSPORT_HKDF_INFO = 'web3c:transport';
export const TRANSPORT_SESSION_ENDPOINT = '/crypt/session';

/**
 * Request header this client sends on every transport-encrypted request to announce its
 * capabilities BEFORE the response is produced. Its mere presence tells the server this
 * bundle understands the v2 payload format (5 segments, compression flag) — never sending
 * it (an older bundle) tells the server to keep emitting v1. Its value tells the server
 * whether deflating the response is actually useful:
 *   - TRANSPORT_ENCODING_DEFLATE  → this browser supports DecompressionStream, deflate is OK
 *   - TRANSPORT_ENCODING_IDENTITY → v2-capable bundle, but this browser lacks DecompressionStream
 * Negotiation is mandatory, not opportunistic: DecompressionStream is Baseline "widely
 * available" (since May 2023) but only ~95.8% global coverage (checked 2026-09-07) — the
 * remaining ~4% must keep working uncompressed rather than fail to decrypt.
 */
export const TRANSPORT_ACCEPT_ENCODING_HEADER = 'x-crypt-accept-encoding';
export const TRANSPORT_ENCODING_IDENTITY = 'identity';
export const TRANSPORT_ENCODING_DEFLATE = 'deflate';

/** Single-char flags carried in the v2 payload itself (wire format, not a header) — keep in
 *  sync byte-for-byte with the nestcommon copy of this file. */
export const TRANSPORT_PAYLOAD_FLAG_NONE = '0';
export const TRANSPORT_PAYLOAD_FLAG_DEFLATE = '1';
