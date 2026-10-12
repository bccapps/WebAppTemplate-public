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

export interface II18nLabelProps {
  id: string;
  params?: any[] | null;
  nolf?: boolean;
}

export interface II18nLabelState {
  label: string;
}

export class I18nLabel extends React.Component<
  II18nLabelProps,
  II18nLabelState
> {
  // i18n ref
  i18nUuid: string | null = null;
  constructor(props: II18nLabelProps) {
    super(props);
    const tmplabel = this.computeLabel(props);
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

  componentDidUpdate(prevProps: II18nLabelProps): void {
    if (
      prevProps.id !== this.props.id ||
      prevProps.params !== this.props.params
    ) {
      this.setState({ label: this.computeLabel(this.props) });
    }
  }

  private computeLabel(props: II18nLabelProps): string {
    return i18n.get(props.id, props.params);
  }

  /**
   *
   * @param event
   */
  onLanguageChanged = (_event: any) => {
    const { id, params } = this.props;
    this.setState({ label: i18n.get(id, params) });
  };

  public render() {
    const { label } = this.state;
    /*
    return (
      <>
        {this.props.nolf ? (
          <div className="I18nLabel-nolf" title={label}>
            {label}&nbsp;
          </div>
        ) : (
          <div title={label}>{label}</div>
        )}
      </>
    );
    */
    return <span title={label}>{label}</span>;
  }
}
