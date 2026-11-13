/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import registry from './secret-formats.json';

/**
 * Typed view of `secret-formats.json`, the single registry of the secret formats minted by the VX apps and libraries
 * (prefix, alphabet, length, expected entropy, where it is minted). The trace sanitizer, the path redaction and
 * mcp-access read their app prefixes from here; the template generates every project's gitleaks rules from the same
 * file (`scripts/gitleaks-config.mjs`). Add a format to the JSON file, never a prefix to a consumer.
 */
export type SecretCharset = 'base64url' | 'base62' | 'hex';

export interface SecretFormat {
  id: string;
  /** App or library that mints it. */
  app: string;
  prefix: string;
  charset: SecretCharset;
  /** Exact body length, or `minLength`..`maxLength`. */
  length?: number;
  minLength?: number;
  maxLength?: number;
  /** Shannon entropy (bits per character, prefix included) under which a match is a placeholder; 0 = no filter. */
  minEntropy: number;
  /** The mcp-access OAuth tokens `<prefix>at_|rt_|cs_` + 43 exist for this prefix. */
  oauth: boolean;
  /** Travels in URLs (path segment): redacted by `redactPath`. */
  inUrl: boolean;
  /** The scanner rule requires a boundary before the prefix (a prefix that also occurs inside identifiers). */
  leftBoundary?: boolean;
  description: string;
  source: string;
}

export interface SecretOAuthFamily {
  markers: readonly string[];
  charset: SecretCharset;
  length: number;
  minEntropy: number;
}

/** A public identifier with a prefix (`cmp_`, `dcr_`): listed so nobody mistakes it for a secret. */
export interface PrefixedIdentifier {
  id: string;
  prefix: string;
  description: string;
}

interface SecretFormatRegistry {
  charsets: Record<SecretCharset, string>;
  fakeMarkers: readonly string[];
  oauth: SecretOAuthFamily;
  formats: readonly SecretFormat[];
  identifiers: readonly PrefixedIdentifier[];
}

const PREFIX_SHAPE = /^[a-z][a-z0-9_]{1,10}_$/;

/** Checks the shape of the registry once, at load: a malformed entry fails the boot (and every spec), not a scan. */
export function validateSecretFormatRegistry(raw: SecretFormatRegistry): SecretFormatRegistry {
  const ids = new Set<string>();
  for (const format of raw.formats) {
    const problem =
      (ids.has(format.id) && 'duplicate id') ||
      (!PREFIX_SHAPE.test(format.prefix) && 'prefix must be lower case and end with "_"') ||
      (!(format.charset in raw.charsets) && `unknown charset ${format.charset}`) ||
      (format.length === undefined && !((format.minLength ?? 0) > 0 && (format.maxLength ?? 0) >= (format.minLength ?? 0)) && 'length or minLength..maxLength required') ||
      (!(format.minEntropy >= 0) && 'minEntropy must be >= 0');
    if (problem) throw new Error(`secret-formats.json: ${format.id}: ${problem}`);
    ids.add(format.id);
  }
  return raw;
}

const REGISTRY = validateSecretFormatRegistry(registry as SecretFormatRegistry);

export const SECRET_FORMATS: readonly SecretFormat[] = Object.freeze(REGISTRY.formats.map((format) => Object.freeze({ ...format })));
export const SECRET_OAUTH_FAMILY: SecretOAuthFamily = Object.freeze({ ...REGISTRY.oauth, markers: Object.freeze([...REGISTRY.oauth.markers]) });
export const PREFIXED_IDENTIFIERS: readonly PrefixedIdentifier[] = Object.freeze(REGISTRY.identifiers.map((entry) => Object.freeze({ ...entry })));
/** Marker that a deliberately fake value carries right after its prefix (`tk_FAKE…`); runtime redaction still applies to it. */
export const FAKE_SECRET_MARKERS: readonly string[] = Object.freeze([...REGISTRY.fakeMarkers]);

const unique = (values: string[]): readonly string[] => Object.freeze([...new Set(values)]);

/** Every prefix of the registry, in registry order (an OAuth token starts with its app prefix: covered). */
export const SECRET_FORMAT_PREFIXES: readonly string[] = unique(SECRET_FORMATS.map((format) => format.prefix));
/** Prefixes of the tokens that travel in URLs. */
export const URL_SECRET_PREFIXES: readonly string[] = unique(SECRET_FORMATS.filter((format) => format.inUrl).map((format) => format.prefix));

/** Alphabet of a charset, as a regular-expression class body (`A-Za-z0-9_-`). */
export function secretCharsetClass(charset: SecretCharset): string {
  return REGISTRY.charsets[charset];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function bodyQuantifier(format: Pick<SecretFormat, 'length' | 'minLength' | 'maxLength'>): string {
  return format.length !== undefined ? `{${format.length}}` : `{${format.minLength},${format.maxLength}}`;
}

const patternCache = new Map<string, RegExp>();

/** `^<prefix>[charset]{length}$` for a key, or `^<prefix>(?:at_|rt_|cs_)[A-Za-z0-9_-]{43}$` for its OAuth tokens (compiled once). */
export function secretFormatPattern(format: SecretFormat, kind: 'key' | 'oauth' = 'key'): RegExp {
  const key = `${kind}|${format.prefix}|${format.charset}|${bodyQuantifier(format)}`;
  let pattern = patternCache.get(key);
  if (!pattern) {
    pattern = buildPattern(format, kind);
    patternCache.set(key, pattern);
  }
  return pattern;
}

function buildPattern(format: SecretFormat, kind: 'key' | 'oauth'): RegExp {
  if (kind === 'oauth') {
    const markers = SECRET_OAUTH_FAMILY.markers.map(escapeRegExp).join('|');
    return new RegExp(`^${escapeRegExp(format.prefix)}(?:${markers})[${secretCharsetClass(SECRET_OAUTH_FAMILY.charset)}]{${SECRET_OAUTH_FAMILY.length}}$`);
  }
  return new RegExp(`^${escapeRegExp(format.prefix)}[${secretCharsetClass(format.charset)}]${bodyQuantifier(format)}$`);
}

/** The registered format a whole value has (its key format, else its OAuth token format), or null. */
export function secretFormatOf(value: string): { format: SecretFormat; kind: 'key' | 'oauth' } | null {
  if (typeof value !== 'string' || value.length > 512) return null;
  for (const format of SECRET_FORMATS) {
    if (!value.startsWith(format.prefix)) continue;
    if (secretFormatPattern(format).test(value)) return { format, kind: 'key' };
    if (format.oauth && secretFormatPattern(format, 'oauth').test(value)) return { format, kind: 'oauth' };
  }
  return null;
}
