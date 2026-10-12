/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import React from 'react';
import ModuleConfigForm from '@/modules_shared/common/components/ui/ModuleConfigForm';

const AdminConfig: React.FC = () => {
  return <ModuleConfigForm moduleId="common" groups={['general']} />;
};

export default AdminConfig;
