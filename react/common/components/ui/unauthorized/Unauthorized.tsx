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
export type IUnauthorizedProps = Record<string, never>;

export interface IUnauthorizedState {
  showForm?: boolean;
}

export default class Unauthorized extends React.Component<
  IUnauthorizedProps,
  IUnauthorizedState
> {
  constructor(props: IUnauthorizedProps) {
    super(props);
    this.state = {};
  }

  handleClose = () => {
    this.setState({ showForm: false });
  };

  showForm = () => {
    // See how to get the item number if clicking on an edit button
    this.setState({ showForm: true });
  };

  public render() {
    return (
      <I18nLabel id="common.unauthorized" />
    );
  }
}
