/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useEffect, useMemo, useState } from 'react';
import { voiceService } from '../../services/VoiceService';
import type { VoiceProviderCatalog } from '../../types';
import { httpResultToPromise } from '@/modules_shared/common/utils/httpResult';
import { VoiceAccessCrud, type VoiceAccessCrudApi } from './VoiceAccessCrud';

export function AdminVoiceAccesses() {
  const [providerCatalog, setProviderCatalog] = useState<VoiceProviderCatalog[]>([]);

  useEffect(() => {
    httpResultToPromise<VoiceProviderCatalog[]>(voiceService.listProviderCatalog())
      .then((data) => setProviderCatalog(Array.isArray(data) ? data : []))
      .catch(() => setProviderCatalog([]));
  }, []);

  const accessApi: VoiceAccessCrudApi = useMemo(() => ({
    list: () => voiceService.listAccesses(),
    create: (p) => voiceService.createAccess(p),
    update: (id, p) => voiceService.updateAccess(id, p),
    remove: (id) => voiceService.removeAccess(id),
  }), []);

  return (
    <VoiceAccessCrud
      accessApi={accessApi}
      titleKey="voice_accessesTitle"
      descriptionKey="voice_adminDescription"
      providerCatalog={providerCatalog}
    />
  );
}

export default AdminVoiceAccesses;
