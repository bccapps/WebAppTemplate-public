/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable } from '@nestjs/common';
import ConfigurationDto from '../dtos/ConfigurationDto';

@Injectable()
export class ConfigurationService {
  /**
   * get configuration of app without database
   * @returns
   */
  async getConfiguration(): Promise<ConfigurationDto[]> {
    return [];
  }
}
