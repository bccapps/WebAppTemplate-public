/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { ToastZone } from '../../components/ui/toast/ToastZone';

class ToastServiceImpl {
  success(key: string, textKey = '', options?: { titleParams?: any[] | null; textParams?: any[] | null }) {
    ToastZone.addMessage(key, textKey, 'success', options);
  }

  error(key: string, textKey = '', options?: { titleParams?: any[] | null; textParams?: any[] | null }) {
    ToastZone.addMessage(key, textKey, 'error', options);
  }

  warning(key: string, textKey = '', options?: { titleParams?: any[] | null; textParams?: any[] | null }) {
    ToastZone.addMessage(key, textKey, 'warning', options);
  }

  info(key: string, textKey = '', options?: { titleParams?: any[] | null; textParams?: any[] | null }) {
    ToastZone.addMessage(key, textKey, 'info', options);
  }
}

export const toastService = new ToastServiceImpl();
