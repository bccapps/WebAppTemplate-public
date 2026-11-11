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
export type { LazyTraceFields, ValidationOutcome, ValidationSource, ValidationTraceOptions } from './validationTrace';
export { REDACTED, TRACE_LIMITS, fingerprint, isPersonalKey, isSensitiveKey, looksSecret, sanitizeTraceFields, sanitizeTraceString } from './traceSanitizer';
export type { TraceFields, TraceScalar, TraceValue } from './traceSanitizer';
export { CHECK_NAME_PATTERN, isValidCheckName } from './traceLine';
export type { TraceLine } from './traceLine';
export { VALIDATION_FILE_PATTERN, resolveValidationLogDir } from './traceFileSink';
export { ValidationCheckRegistry, loadFrontTraceRules } from './ValidationCheckRegistry';
export type { FrontTraceRule } from './ValidationCheckRegistry';
export { ValidationTraceService } from './ValidationTraceService';
export { ValidationTraceModule } from './ValidationTraceModule';
export type { ValidationTraceModuleOptions } from './ValidationTraceModule';
