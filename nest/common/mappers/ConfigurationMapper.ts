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
import ConfigurationEntity from '../entities/ConfigurationEntity';
import { DtoMapper } from './DtoMapper';

@Injectable()
export class ConfigurationMapper extends DtoMapper {
  constructor() {
    super();
  }
  /**
   *
   * @param entity
   */
  public override mapFromEntity(entity: ConfigurationEntity) {
    if (entity) {
      const dto = new ConfigurationDto();
      dto.name = entity.name;
      dto.value = entity.value;
      dto.description = entity.description;
      return dto;
    }
    return null;
  }
}
