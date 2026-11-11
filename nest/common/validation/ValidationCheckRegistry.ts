/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable } from '@nestjs/common';
import { FrontTraceRule, currentCheckIndex } from './checkIndex';

/**
 * Injectable view of the checks the modules declare (`validation/checks.json`, see `checkIndex.ts`): the allow-list of
 * the traces the front may send, with their field rules.
 */
@Injectable()
export class ValidationCheckRegistry {
  /** Rule of a trace the front wants to send, or null when no front check declares it (or a back-only check uses it). */
  frontRule(trace: string): FrontTraceRule | null {
    return currentCheckIndex().front.get(trace) ?? null;
  }
}
