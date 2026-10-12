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
import ModuleConfigForm from '@/modules_shared/common/components/ui/ModuleConfigForm';

const AdminAlerts: React.FC = () => {
  return (
    <div className="page-stack">
      <div className="section-header">
        <div>
          <h2>{i18n.get('common.adminAlerts.title')}</h2>
          <p className="subtext">{i18n.get('common.adminAlerts.description')}</p>
        </div>
      </div>
      <ModuleConfigForm moduleId="common" groups={['monitoring']} />
    </div>
  );
};

export default AdminAlerts;
