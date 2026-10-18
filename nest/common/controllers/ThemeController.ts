/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Res,
  UseInterceptors,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ThemeCreateDto } from '../dtos/ThemeCreateDto';
import { ThemeCssUpdateDto } from '../dtos/ThemeCssUpdateDto';
import { Response } from 'express';
import { Public } from '../decorators/Public';
import { AdminOnlyInterceptor } from '../interceptors/AdminOnlyInterceptor';
import { ThemeService } from '../services/ThemeService';
import { readFileSync } from 'fs';
import { join } from 'path';

@ApiTags('themes')
@Controller()
export class ThemeController {
  constructor(private readonly themeService: ThemeService) {}

  @Public()
  @Get('/api/v1/themes/active')
  async listActive() {
    return await this.themeService.listActive();
  }

  @Public()
  @Get('/api/v1/themes/:code/css')
  async getCss(@Param('code') code: string, @Res() res: Response) {
    const css = await this.themeService.getCss(code);
    if (css == null) {
      res.status(404).send('');
      return;
    }
    res.setHeader('Content-Type', 'text/css');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(css);
  }

  @Get('/api/v1/admin/themes')
  @UseInterceptors(AdminOnlyInterceptor)
  async list() {
    return await this.themeService.list();
  }

  @Post('/api/v1/admin/themes')
  @UseInterceptors(AdminOnlyInterceptor)
  async create(@Body() body: ThemeCreateDto) {
    // Read the static CSS files to provide context to the LLM
    const colorsCss = this.readStaticCss('colors.css');
    const themeCss = this.readStaticCss('theme_default.css');
    const mergedCss = colorsCss + '\n\n' + themeCss;

    return await this.themeService.create(body.name, body.description, mergedCss);
  }

  @Get('/api/v1/admin/themes/:id')
  @UseInterceptors(AdminOnlyInterceptor)
  async getOne(@Param('id') id: string) {
    return await this.themeService.getFullTheme(Number(id));
  }

  @Put('/api/v1/admin/themes/:id/css')
  @UseInterceptors(AdminOnlyInterceptor)
  async updateCss(@Param('id') id: string, @Body() body: ThemeCssUpdateDto) {
    return await this.themeService.updateCss(Number(id), body.css);
  }

  @Put('/api/v1/admin/themes/:id/activate')
  @UseInterceptors(AdminOnlyInterceptor)
  async activate(@Param('id') id: string) {
    await this.themeService.activate(Number(id));
    return { success: true };
  }

  @Put('/api/v1/admin/themes/:id/deactivate')
  @UseInterceptors(AdminOnlyInterceptor)
  async deactivate(@Param('id') id: string) {
    await this.themeService.deactivate(Number(id));
    return { success: true };
  }

  @Delete('/api/v1/admin/themes/:id')
  @UseInterceptors(AdminOnlyInterceptor)
  async remove(@Param('id') id: string) {
    await this.themeService.deleteTheme(Number(id));
    return { success: true };
  }

  private readStaticCss(filename: string): string {
    // Try multiple paths (dev vs built)
    const paths = [
      join(process.cwd(), 'front', 'src', 'styles', filename),
      join(process.cwd(), '..', 'front', 'src', 'styles', filename),
    ];
    for (const p of paths) {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        // try next
      }
    }
    return '';
  }
}
