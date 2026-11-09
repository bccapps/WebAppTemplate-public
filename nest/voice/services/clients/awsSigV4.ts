/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { createHash, createHmac } from 'crypto';

/**
 * Minimal AWS Signature Version 4 signer (header based, `AWS4-HMAC-SHA256`), enough for the JSON / REST services we call (Polly).
 * Tested against the official AWS examples and test-suite vectors (`awsSigV4.spec.ts`). No SDK dependency on purpose.
 *
 * https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv4-create-signed-request.html
 */

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Temporary credentials only: sent as `x-amz-security-token` and signed. */
  sessionToken?: string;
}

export interface SigV4Request {
  method: string;
  /** Absolute URL; its host, path and query are signed. */
  url: string;
  /** Request headers to sign (`host` and `x-amz-date` are added when absent). */
  headers: Record<string, string>;
  body: string | Uint8Array;
  region: string;
  service: string;
  /** Signing time (tests pin it). */
  now?: Date;
}

const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data, 'utf8').digest();

/** RFC 3986 percent-encoding (what SigV4 asks for: only unreserved characters stay). */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** `20150830T123600Z`. */
export function amzDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Canonical URI: each decoded path segment encoded twice (every service but S3). */
export function canonicalUri(pathname: string): string {
  const segments = pathname.split('/').map((segment) => uriEncode(uriEncode(safeDecode(segment))));
  return segments.join('/') || '/';
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Canonical query string: names and values encoded, sorted by name then value. */
export function canonicalQuery(params: URLSearchParams): string {
  return [...params.entries()]
    .map(([name, value]) => [uriEncode(name), uriEncode(value)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

function canonicalHeaders(headers: Record<string, string>): { block: string; signed: string } {
  const entries = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, ' ')] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { block: entries.map(([n, v]) => `${n}:${v}\n`).join(''), signed: entries.map(([n]) => n).join(';') };
}

/** The signing key: HMAC chain over date, region, service and `aws4_request`. */
export function signingKey(secretAccessKey: string, dateStamp: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), service), 'aws4_request');
}

/** Canonical request text (exposed for tests). */
export function canonicalRequest(method: string, url: URL, headers: Record<string, string>, body: string | Uint8Array): string {
  const { block, signed } = canonicalHeaders(headers);
  return [method.toUpperCase(), canonicalUri(url.pathname), canonicalQuery(url.searchParams), block, signed, sha256Hex(body)].join('\n');
}

/**
 * Headers to send: the given ones plus `host`, `x-amz-date`, `x-amz-security-token` (temporary credentials) and `authorization`.
 * Header names are lower-cased.
 */
export function signSigV4(request: SigV4Request, credentials: SigV4Credentials): Record<string, string> {
  const url = new URL(request.url);
  const stamp = amzDate(request.now ?? new Date());
  const dateStamp = stamp.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) headers[name.toLowerCase()] = value;
  headers.host = headers.host ?? url.host;
  headers['x-amz-date'] = stamp;
  if (credentials.sessionToken) headers['x-amz-security-token'] = credentials.sessionToken;

  const scope = `${dateStamp}/${request.region}/${request.service}/aws4_request`;
  const canonical = canonicalRequest(request.method, url, headers, request.body);
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256Hex(canonical)].join('\n');
  const signature = createHmac('sha256', signingKey(credentials.secretAccessKey, dateStamp, request.region, request.service))
    .update(toSign, 'utf8')
    .digest('hex');
  const { signed } = canonicalHeaders(headers);
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`;
  return headers;
}
