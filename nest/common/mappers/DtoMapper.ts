/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable } from '@nestjs/common';

@Injectable()
export class DtoMapper {
  /**
   *
   * @param entities
   * @returns
   */
  mapFromEntities(entities: any[]) {
    if (!Array.isArray(entities) || entities.length === 0) {
      return [];
    }
    const dtos: any[] = [];
    entities.forEach((entity: any) => {
      dtos.push(this.mapFromEntity(entity));
    });
    return dtos;
  }

  /**
   *
   * @param entities
   * @returns
   */
  mapFromEntity(entity: any) {
    throw 'mapFromEntity function Must to be implemented';
  }
}
