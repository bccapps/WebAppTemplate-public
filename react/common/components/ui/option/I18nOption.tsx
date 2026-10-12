/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import * as React from 'react';
import { i18n } from '../../../core/i18n/I18n';

export interface II18nOptionProps {
  id: string;
  value: string;
}

export interface II18nOptionState {
  label: string;
}

export class I18nOption extends React.Component<
  II18nOptionProps,
  II18nOptionState
> {
  // i18n ref
  i18nUuid: string | null = null;
  constructor(props: II18nOptionProps) {
    super(props);
    const tmplabel = i18n.get(props.id);
    this.state = {
      label: tmplabel
    };
  }

  componentDidMount(): void {
    // register i18n
    this.i18nUuid = i18n.addEventListener(
      'languageChanged',
      this.onLanguageChanged
    );
  }
  componentWillUnmount(): void {
    // unregister i18n
    i18n.removeEventListerner(this.i18nUuid);
  }

  /**
   *
   * @param event
   */
  //onLanguageChanged = (event: any) => {
  onLanguageChanged = () => {
    const { id } = this.props;
    this.setState({ label: i18n.get(id) });
  };

  public render() {
    const { label } = this.state;
    return <option value={this.props.value}>{label}</option>;
    //return <span title={label}>{label}</span>;
  }
}
