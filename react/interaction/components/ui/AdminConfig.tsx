/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import React from 'react';
import ModuleConfigForm from '../../../common/components/ui/ModuleConfigForm';

/** « Config » tab of the module in the admin page (auto-discovered): the generic form of the `interaction_*` settings. */
const AdminConfig: React.FC = () => <ModuleConfigForm moduleId="interaction" />;

export default AdminConfig;
