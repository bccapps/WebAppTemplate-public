/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import React, { useState } from 'react';
import { CircularProgress, IconButton, Tooltip } from '@mui/material';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import { i18n } from '@/modules_shared/common/core/i18n/I18n';
import { toastService } from '@/modules_shared/common/core/toast/ToastService';
import { httpService } from '@/modules_shared/common/core/http/HttpService';
import { configurationService } from '@/modules_shared/common/services/ConfigurationService';
import { httpResultToPromise } from '@/modules_shared/common/utils/httpResult';
import { useLlmTranslateAvailable } from '@/modules_shared/common/hooks/useLlmTranslateAvailable';

interface TranslateIconButtonProps {
  /** Source text (typically the French field's current value) to translate from. */
  sourceText: string;
  /** Locale of the field this button fills in. */
  targetLocale: string;
  /** Locale of `sourceText`, defaults to 'fr'. */
  sourceLocale?: string;
  onTranslated: (text: string) => void;
  disabled?: boolean;
}

/**
 * Magic-wand "Traduire" button placed to the left of a translatable label field — hidden unless
 * llm-client has a usable default model configured. Lives in `common` (linked by every app,
 * unlike `llm-client`) and talks to the llm-client backend purely by URL, so modules that use it
 * (cms, user, commerce, ...) never take a compile-time dependency on the llm-client module.
 */
export const TranslateIconButton: React.FC<TranslateIconButtonProps> = ({
  sourceText,
  targetLocale,
  sourceLocale,
  onTranslated,
  disabled,
}) => {
  const available = useLlmTranslateAvailable();
  const [pending, setPending] = useState(false);

  if (!available || !sourceText.trim()) return null;

  const handleClick = () => {
    setPending(true);
    httpResultToPromise<{ translated: string }>(
      httpService.post(`${configurationService.getApiUrl('default')}/llm-client/translate`, {
        text: sourceText,
        targetLocale,
        sourceLocale,
      }),
    )
      .then((result: any) => onTranslated((result?.data ?? result)?.translated))
      .catch(() => toastService.error(i18n.get('llm_translateError')))
      .finally(() => setPending(false));
  };

  return (
    <Tooltip title={i18n.get('llm_translate')}>
      <span>
        <IconButton size="small" onClick={handleClick} disabled={disabled || pending} edge="start">
          {pending ? <CircularProgress size={16} /> : <AutoFixHighIcon fontSize="small" />}
        </IconButton>
      </span>
    </Tooltip>
  );
};
