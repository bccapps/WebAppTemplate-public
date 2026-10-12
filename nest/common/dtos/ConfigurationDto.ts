/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { ApiProperty } from '@nestjs/swagger';

export default class ConfigurationDto {
  @ApiProperty({
    description: 'Configuration variable name'
  })
  name: string;
  @ApiProperty({
    description: 'Configuration variable value'
  })
  value: string;
  @ApiProperty({
    description: 'Configuration variable description'
  })
  description: string;
}
