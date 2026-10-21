/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import * as React from 'react';
import { I18nLabel } from '../label/I18nLabel';

export interface IUnavailableProps {
  message?: string;
}

export type IUnavailableState = Record<string, never>;

export class Unavailable extends React.Component<
  IUnavailableProps,
  IUnavailableState
> {
  constructor(props: IUnavailableProps) {
    super(props);

    this.state = {};
  }

  public render() {
    return (
      <h1>
        <I18nLabel id="common.app.unavailable" />
        {this.props.message !== undefined ? <p>{this.props.message}</p> : ''}
      </h1>
    );
  }
}
