/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ThemeEntity } from '../entities/ThemeEntity';
import { FunctionalException } from '../exceptions/FunctionalException';

// Lazy import to avoid circular dependency — LlmClientService injected optionally
interface LlmClient {
  generateWithFallback(opts: {
    systemPrompt: string;
    userPrompt: string;
    temperature: number;
    requestId?: string;
  }): Promise<string>;
}

export type ThemeDto = {
  id: number;
  name: string;
  code: string;
  description: string | null;
  active: boolean;
  isDefault: boolean;
  hasCss: boolean;
  createdAt: string;
  updatedAt: string;
};

@Injectable()
export class ThemeService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ThemeService.name);

  constructor(
    @InjectRepository(ThemeEntity)
    private readonly repo: Repository<ThemeEntity>,
    @Optional() private readonly llmClient?: LlmClient,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.seedDefault();
  }

  async seedDefault(): Promise<void> {
    const existing = await this.repo.findOne({ where: { code: 'default' } });
    if (!existing) {
      const theme = this.repo.create({
        name: 'Default',
        code: 'default',
        active: true,
        isDefault: true,
        css: null,
      });
      await this.repo.save(theme);
      this.logger.log('Seeded default theme');
    }
  }

  async list(): Promise<ThemeDto[]> {
    const themes = await this.repo.find({
      select: ['id', 'name', 'code', 'description', 'active', 'isDefault', 'createdAt', 'updatedAt'],
      order: { isDefault: 'DESC', name: 'ASC' },
    });
    return themes.map((t) => this.toDto(t));
  }

  async listActive(): Promise<ThemeDto[]> {
    const themes = await this.repo.find({
      select: ['id', 'name', 'code', 'description', 'active', 'isDefault', 'createdAt', 'updatedAt'],
      where: { active: true },
      order: { isDefault: 'DESC', name: 'ASC' },
    });
    return themes.map((t) => this.toDto(t));
  }

  async getCss(code: string): Promise<string | null> {
    const theme = await this.repo.findOne({
      select: ['css'],
      where: { code, active: true },
    });
    return theme?.css ?? null;
  }

  async create(name: string, description: string, colorsCss: string): Promise<ThemeDto> {
    const code = name.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    if (!code) throw new FunctionalException('THM', 'Invalid theme name');

    const existing = await this.repo.findOne({ where: { code } });
    if (existing) throw new FunctionalException('THM', 'A theme with this code already exists');

    // Read the default CSS from the default theme or use empty
    const defaultThemeCss = await this.getDefaultCssContext(colorsCss);

    // Generate CSS via LLM
    let css: string | null = null;
    if (this.llmClient) {
      css = await this.generateCssWithLlm(name, description, defaultThemeCss);
    } else {
      this.logger.warn('LLM client not available — theme created without CSS');
    }

    const theme = this.repo.create({ name: name.trim(), code, description, css, active: true });
    await this.repo.save(theme);
    return this.toDto(theme);
  }

  async activate(id: number): Promise<void> {
    const theme = await this.repo.findOne({ where: { id } });
    if (!theme) throw new FunctionalException('THM', 'Theme not found');
    theme.active = true;
    await this.repo.save(theme);
  }

  async updateCss(id: number, css: string): Promise<ThemeDto> {
    const theme = await this.repo.findOne({ where: { id } });
    if (!theme) throw new FunctionalException('THM', 'Theme not found');
    if (theme.isDefault) throw new FunctionalException('THM', 'Cannot edit the default theme CSS');
    theme.css = css;
    await this.repo.save(theme);
    return this.toDto(theme);
  }

  async getFullTheme(id: number): Promise<{ css: string | null } & ThemeDto> {
    const theme = await this.repo.findOne({ where: { id } });
    if (!theme) throw new FunctionalException('THM', 'Theme not found');
    return { ...this.toDto(theme), css: theme.css };
  }

  async deactivate(id: number): Promise<void> {
    const theme = await this.repo.findOne({ where: { id } });
    if (!theme) throw new FunctionalException('THM', 'Theme not found');
    if (theme.isDefault) throw new FunctionalException('THM', 'Cannot deactivate the default theme');
    theme.active = false;
    await this.repo.save(theme);
  }

  async deleteTheme(id: number): Promise<void> {
    const theme = await this.repo.findOne({ where: { id } });
    if (!theme) throw new FunctionalException('THM', 'Theme not found');
    if (theme.isDefault) throw new FunctionalException('THM', 'Cannot delete the default theme');
    await this.repo.remove(theme);
  }

  private async generateCssWithLlm(name: string, description: string, baseCss: string): Promise<string> {
    const systemPrompt = `You are a CSS theme generator. Generate a single CSS file that defines a complete visual theme.
Rules:
- Return ONLY valid CSS code, no explanations, no markdown fences, no comments about what you changed
- Do NOT create new CSS classes or selectors
- Only modify existing styles and CSS variable values from the base CSS provided
- The CSS must be a complete standalone file (not a diff)
- Preserve all :root and [data-theme='dark'] variable blocks
- You may change colors, fonts, shadows, gradients, border-radius, transitions
- Keep the same structure and selector order as the base CSS`;

    const userPrompt = `Generate a CSS theme named "${name}" with the following style: ${description}

Base CSS to transform:
${baseCss}`;

    const result = await this.llmClient!.generateWithFallback({
      systemPrompt,
      userPrompt,
      temperature: 0.7,
      requestId: `theme-${name}`,
    });

    // Strip markdown fences if the LLM wrapped it anyway
    let css = result.trim();
    if (css.startsWith('```')) {
      css = css.replace(/^```(?:css)?\n?/, '').replace(/\n?```$/, '').trim();
    }
    return css;
  }

  private async getDefaultCssContext(colorsCss: string): Promise<string> {
    // Merge colors.css + theme_default.css content
    // Since we don't have filesystem access from the service, the controller passes colorsCss
    // and we read the default theme's CSS if it had one (it doesn't — it's the static file)
    // The controller will read the static files and pass them merged
    return colorsCss;
  }

  private toDto(entity: ThemeEntity): ThemeDto {
    return {
      id: entity.id,
      name: entity.name,
      code: entity.code,
      description: entity.description,
      active: entity.active,
      isDefault: entity.isDefault,
      hasCss: entity.css != null && entity.css.length > 0,
      createdAt: entity.createdAt?.toISOString(),
      updatedAt: entity.updatedAt?.toISOString(),
    };
  }
}
