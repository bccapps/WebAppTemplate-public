/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { NestModulePlugin } from '../common/plugins/NestModulePlugin';
import { VoiceModule } from './VoiceModule';

export const plugin: NestModulePlugin = { id: 'voice', module: VoiceModule };
