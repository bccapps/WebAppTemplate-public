/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import * as React from 'react';
import { toast, ToastContainer } from 'react-toastify';
import { I18nLabel } from '../label/I18nLabel';
import 'react-toastify/dist/ReactToastify.css';
// Imported after the library stylesheet: it only adds the dark scheme on top.
import '../../../styles/tokens.css';
import './ToastZone.css';
import { Box } from '@mui/material';

type ToastMessageOptions = {
  titleParams?: any[] | null
  textParams?: any[] | null
}

export interface IToastZoneProps {}
export interface IToastZoneState {}
export class ToastZone extends React.Component<
  IToastZoneProps,
  IToastZoneState
> {
  static id = 0;

  constructor(props: IToastZoneProps) {
    super(props);
  }

  static addMessage(ptitle: string, ptext: string, plevel: string, options?: ToastMessageOptions) {
    // Add a routine to remove elements with displayed==false ? ==> NO, we will expose the history in some way if needed
    //console.log('Adding Toast : ' + ptitle);
    /*
    const text = ({ closeToast, toastProps }) => (
      <I18nLabel key={'toastlabel_' + ToastZone.id} id={ptext}></I18nLabel>
    );
    const params = { position: toast.POSITION.BOTTOM_RIGHT, className: 'foo-bar', autoClose: 15000 };
    */
    const text = () => (
      <Box>
        <b>
          <I18nLabel key={'toasttitle_' + ToastZone.id} id={ptitle} nolf params={options?.titleParams} />
        </b>
        <br />
        {ptext != '' ? (
          <I18nLabel key={'toastlabel_' + ToastZone.id} id={ptext} nolf params={options?.textParams} />
        ) : (
          ''
        )}
      </Box>
    );
    //const params = { position: toast.POSITION.BOTTOM_RIGHT };
    const params = {};
    if (plevel == 'warning') toast.warn(text, params);
    else if (plevel == 'success') toast.success(text, params);
    else if (plevel == 'error') toast.error(text, params);
    else if (plevel == 'info') toast(text, params);
    ToastZone.id += 1;
  }

  //{console.log('Toasts %o', appSession.get('toasts'))}
  public render() {
    return <ToastContainer autoClose={6000} />;
  }
}
