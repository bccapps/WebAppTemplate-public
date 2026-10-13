/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import React, { useEffect, useState } from 'react';
import Preloader from './Preloader';
import { Loader } from '../../components/ui/loader/Loader';

type PreloaderGateProps = {
  apiUrl?: string;
  /** Blocking services: nothing renders until they are all loaded. */
  services: any[];
  /** Started after the configuration, never awaited (see `buildPreloadPlan`). */
  background?: any[];
  children?: React.ReactNode;
};

export const PreloaderGate: React.FC<PreloaderGateProps> = ({ apiUrl = "/api", services, background, children }) => {
  const [preloader] = useState(() => new Preloader());
  const [, forceRender] = useState(0);

  useEffect(() => {
    services?.forEach(svc => preloader.add(svc));
    background?.forEach(svc => preloader.addBackground(svc));
    const onReady = preloader.addEventListener('ready', () => forceRender(x => x + 1));
    preloader.load(apiUrl);
    return () => {
      preloader.removeEventListerner(onReady);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiUrl, services, background]);

  if (!preloader.ready()) {
    return <Loader label={preloader.getLoadLabel()} />;
  }
  return <>{children}</>;
};

export default PreloaderGate;


