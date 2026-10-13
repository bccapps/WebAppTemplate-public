/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { ReactNode } from 'react';
import Unauthorized from '../components/ui/unauthorized/Unauthorized';
import { AdminTokenGate } from '../components/ui/admin/AdminTokenGate';
import { sessionAuth } from '../auth/sessionAuth';
import { useSessionKeys } from '../hooks/useSessionKeys';
import type { RouteGuard } from './AppPlugin';
import { hasFeature, isFeatureGatingActive } from './featureAccess';

interface GuardProps {
  children: ReactNode;
}

/** Admins only; in anonymous mode asks for the admin key (see `AdminTokenGate`). */
export function RequireAdmin({ children }: GuardProps) {
  return <AdminTokenGate>{children}</AdminTokenGate>;
}

/** Any signed-in visitor (in anonymous mode: the admin). */
export function RequireAuth({ children }: GuardProps) {
  useSessionKeys(['user']);
  return sessionAuth.isAuth() ? <>{children}</> : <Unauthorized />;
}

/**
 * Guard factory: the visitor must have feature `featureId`. Inactive (always lets through) while no feature system is
 * registered, i.e. without the `user` plugin (see `registerFeatureChecker`).
 */
export function RequireFeature(featureId: string): RouteGuard {
  const Guard = ({ children }: GuardProps) => {
    useSessionKeys(['user']);
    return !isFeatureGatingActive() || hasFeature(featureId) ? <>{children}</> : <Unauthorized />;
  };
  Guard.displayName = `RequireFeature(${featureId})`;
  return Guard;
}
