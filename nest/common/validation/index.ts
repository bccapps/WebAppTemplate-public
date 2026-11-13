/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

export {
  VALIDATION_OUTCOMES,
  VALIDATION_TRACE_ENVS,
  configureValidationTrace,
  flushValidationTrace,
  isValidationTraceEnabled,
  isValidationTraceEnabledFor,
  vtrace,
} from './validationTrace';
export type { LazyTraceFields, RecordContext, ValidationOutcome, ValidationSource, ValidationTraceOptions } from './validationTrace';
export { REDACTED, TRACE_LIMITS, fingerprint, isPersonalKey, isSensitiveKey, looksSecret, sanitizeTraceFields, sanitizeTraceString } from './traceSanitizer';
export type { TraceFieldRules, TraceFieldType, TraceFields, TraceScalar, TraceValue } from './traceSanitizer';
export {
  FAKE_SECRET_MARKERS,
  PREFIXED_IDENTIFIERS,
  SECRET_FORMATS,
  SECRET_FORMAT_PREFIXES,
  SECRET_OAUTH_FAMILY,
  URL_SECRET_PREFIXES,
  secretCharsetClass,
  secretFormatOf,
  secretFormatPattern,
} from './secretFormats';
export type { PrefixedIdentifier, SecretCharset, SecretFormat, SecretOAuthFamily } from './secretFormats';
export { CHECK_NAME_PATTERN, isValidCheckName } from './traceLine';
export type { TraceLine } from './traceLine';
export { TRACE_CLASS_SHARE, VALIDATION_FILE_PATTERN, resolveValidationLogDir } from './traceFileSink';
export type { TraceClass } from './traceFileSink';
export { currentCheckIndex, defaultCheckRoots, fieldRulesOf, loadCheckIndex } from './checkIndex';
export type { CheckIndex, FrontTraceRule } from './checkIndex';
export { ValidationCheckRegistry } from './ValidationCheckRegistry';
export { ValidationTraceService } from './ValidationTraceService';
export { ValidationTraceModule } from './ValidationTraceModule';
