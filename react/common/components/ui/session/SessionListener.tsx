/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import * as React from 'react';
import { appSession } from '../../../core/session/AppSession';

export interface ISessionListenerProps {
  keys: string[];
  children?: React.ReactNode;
}

export interface ISessionListenerState {}

export class SessionListener extends React.Component<
  ISessionListenerProps,
  ISessionListenerState
> {
  listeners: string[] = [];

  constructor(props: ISessionListenerProps) {
    super(props);

    this.state = {};
  }

  componentDidMount(): void {
    this.props.keys?.map((key) => {
      this.listeners.push(
        appSession.addEventListener(key, this.sessionListenerHandle)
      );
    });
  }

  componentWillUnmount(): void {
    this.listeners.map((listener) => {
      appSession.removeEventListerner(listener);
    });
  }

  sessionListenerHandle = (_event: any) => {
    //console.log('Session update : ', event);
    this.forceUpdate();
  };

  public render() {
    /*
    console.log(
      'CHILDREN, typeof=' +
        typeof this.props.children +
        ' - key=' +
        this.props.keys +
        ' : ',
      this.props.children
    );
    */
    if (
      this.props.children === undefined ||
      this.props.children === null ||
      this.props.children === ''
    ) {
      return null;
    }

    const items = React.Children.map(this.props.children, (item: any) => {
      return React.cloneElement(item, item.props);
    });

    if (!items || items.length === 0) {
      return null;
    }

    return <>{items}</>;
  }
}
