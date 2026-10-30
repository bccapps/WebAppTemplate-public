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
 * both here and on the reactcommon counterpart — so a front bundle cached
 * from before this change keeps working against a v2-capable backend, and a
 * v2-aware front keeps working against a backend that hasn't rolled out yet.
 */
export const TRANSPORT_PAYLOAD_VERSION = 'v2';
export const TRANSPORT_PAYLOAD_VERSION_LEGACY = 'v1';
export const STORAGE_SALT_FALLBACK = 'web3c:db';
export const TRANSPORT_HKDF_INFO = Buffer.from('web3c:transport', 'utf8');
export const TRANSPORT_SESSION_SALT = Buffer.from('web3c:transport-salt', 'utf8');
export const DEFAULT_SESSION_TTL_MS = 10 * 60 * 1000;
/**
 * Fallback of `common_cryptSessionMaxLive`: most transport sessions alive at once (in memory, or in Redis across
 * replicas). `POST /crypt/session` is anonymous; past the cap the oldest sessions are evicted (their next responses go
 * out unencrypted over HTTPS until the client renegotiates). ~300 bytes each: 50 000 ≈ 15 MB.
 */
export const DEFAULT_MAX_LIVE_SESSIONS = 50_000;
export const TRANSPORT_SESSION_HEADER = 'x-crypt-session';
export const TRANSPORT_ENCRYPTED_HEADER = 'x-crypt-encrypted';
export const TRANSPORT_VERSION_HEADER = 'x-crypt-version';
export const TRANSPORT_PAYLOAD_SEPARATOR = ':';

/**
 * Request header a client uses to announce its transport capabilities BEFORE
 * any response is produced. Its mere presence tells the server the caller's
 * JS understands the v2 payload format (5 segments, compression flag) — its
 * absence means "legacy client, keep emitting v1". Its value tells the server
 * whether the caller can actually decompress a deflated payload:
 *   - header absent                          → legacy client, always v1, never compressed
 *   - header = TRANSPORT_ENCODING_IDENTITY   → v2-capable client, no DecompressionStream support
 *   - header = TRANSPORT_ENCODING_DEFLATE    → v2-capable client, may receive a deflated payload
 * Negotiation is mandatory (not "compress opportunistically then hope the
 * client can read it") because ~4% of browsers lack DecompressionStream
 * (caniyouse, checked 2026-09-07) — see PERFORMANCE_PLAN.md §2.3.
 */
export const TRANSPORT_ACCEPT_ENCODING_HEADER = 'x-crypt-accept-encoding';
export const TRANSPORT_ENCODING_IDENTITY = 'identity';
export const TRANSPORT_ENCODING_DEFLATE = 'deflate';

/** Single-char flags carried in the v2 payload itself (wire format, not a header) — keep in
 *  sync byte-for-byte with the reactcommon copy of this file. */
export const TRANSPORT_PAYLOAD_FLAG_NONE = '0';
export const TRANSPORT_PAYLOAD_FLAG_DEFLATE = '1';

/** Fallback when the `common_transport_deflate_threshold` module config entry hasn't been
 *  seeded yet (mirrors the `?? 1024` fallback already used for `common_gzip_threshold` in
 *  back/src/main.ts). Below this plaintext size, deflating costs more CPU than it saves. */
export const DEFAULT_TRANSPORT_DEFLATE_THRESHOLD_BYTES = 1024;
