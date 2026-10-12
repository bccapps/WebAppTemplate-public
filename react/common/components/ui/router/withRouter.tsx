/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useLocation, useNavigate, useParams } from 'react-router-dom';

export function withRouter(Child: any) {
  return (props: any) => {
    const location = useLocation();
    const navigate = useNavigate();
    const params = useParams();

    return (
      <Child
        {...props}
        navigate={navigate}
        location={location}
        params={params}
      />
    );
  };
}
