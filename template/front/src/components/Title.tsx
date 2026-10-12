/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import React from 'react';
import { i18n } from '@/modules_shared/common/core/i18n/I18n';

type TitleProps = {
  className?: string;
  style?: React.CSSProperties;
};

const FONT_SIZE = 32;
const SUB_FONT_SIZE = Math.round(FONT_SIZE * 0.6);
const DEFAULT_SITE_NAME = i18n.get('custom.app.name');

type ImportMetaWithEnv = ImportMeta & {
  env?: Record<string, string | undefined>;
};

const getTitleParts = () => {
  const rawName =
    ((import.meta as ImportMetaWithEnv).env?.VITE_PROJECT_NAME ?? '').trim() ||
    DEFAULT_SITE_NAME;
  const lastSpaceIndex = rawName.lastIndexOf(' ');

  if (lastSpaceIndex === -1) {
    return { primary: rawName, secondary: '' };
  }

  const primary = rawName.slice(0, lastSpaceIndex).trim();
  const secondary = rawName.slice(lastSpaceIndex + 1).trim();

  if (!primary || !secondary) {
    return { primary: rawName, secondary: '' };
  }

  return { primary, secondary };
};

export const Title: React.FC<TitleProps> = ({ className, style }) => {
  const { primary, secondary } = getTitleParts();

  return (
    <span
      aria-label={primary + (secondary ? ` ${secondary}` : '')}
      className={className}
      style={{
        position: 'relative',
        display: 'inline-block',
        margin: 0,
        lineHeight: 1,
        fontSize: 0,
        ...style,
      }}
    >
      <span
        style={{
          fontFamily: '"Poppins", "Poppins Medium", sans-serif',
          fontWeight: 500,
          fontSize: FONT_SIZE,
          display: 'inline-block',
        }}
      >
        {primary}
      </span>
      {secondary && (
        <span
          style={{
            position: 'absolute',
            top: FONT_SIZE,
            left: '65%',
            transform: 'translateX(-50%)',
            fontFamily: '"Montserrat", sans-serif',
            fontWeight: 400,
            fontSize: SUB_FONT_SIZE,
            lineHeight: 1,
            whiteSpace: 'nowrap',
          }}
        >
          {secondary}
        </span>
      )}
    </span>
  );
};
