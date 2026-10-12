/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { ApiProperty } from "@nestjs/swagger";

export default class ResponseDto {
  @ApiProperty({
    description: "True if call was successful",
  })
  isSuccess: boolean;

  @ApiProperty({
    description: "Message",
  })
  message: string;

  @ApiProperty({
    description: "Response data",
  })
  data: any;
}
