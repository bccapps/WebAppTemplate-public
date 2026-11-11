/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// `toastService.notice` in the node environment (no jsdom in the project): react-toastify, the ToastZone component and
// the i18n singleton are replaced by fakes, and the content element the service builds is rendered to static markup.
// What a real browser does with the container (stacking, the actual click, the closing animation) is not covered here.

import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const toastMock = vi.hoisted(() => {
  const fn = Object.assign(vi.fn(), { isActive: vi.fn(), update: vi.fn() });
  return fn;
});
const addMessage = vi.hoisted(() => vi.fn());

vi.mock('react-toastify', () => ({ toast: toastMock }));
vi.mock('../../components/ui/toast/ToastZone', () => ({ ToastZone: { addMessage } }));
vi.mock('../i18n/I18n', () => ({
  i18n: { get: (key: string) => ({ 'n.title': 'Hello {name}', 'n.hint': 'Click to open', 'n.count': '{n} items, {n} again, {missing}', 'n.proto': '{constructor}{toString}' })[key] ?? key },
}));

import { toastNoticeText, toastService } from './ToastService';

type Options = { toastId?: string; type: string; closeOnClick: boolean; onClick?: () => void; render?: () => ReactNode };
const html = (render: () => ReactNode) => renderToStaticMarkup(render() as never);

/** The options and content of the last `toast(...)` or `toast.update(...)` call. */
function shown(): { options: Options; markup: string } {
  const created = toastMock.mock.calls.at(-1) as [() => ReactNode, Options] | undefined;
  const updated = toastMock.update.mock.calls.at(-1) as [string, Options & { render: () => ReactNode }] | undefined;
  if (updated && (!created || toastMock.update.mock.invocationCallOrder.at(-1)! > toastMock.mock.invocationCallOrder.at(-1)!)) return { options: updated[1], markup: html(updated[1].render) };
  return { options: created![1], markup: html(created![0]) };
}

beforeEach(() => {
  toastMock.mockReset();
  toastMock.isActive.mockReset();
  toastMock.update.mockReset();
  addMessage.mockReset();
});

describe('toastNoticeText', () => {
  it('shows a raw text as is, a key translated with its named params, and an unknown placeholder untouched', () => {
    expect(toastNoticeText({ raw: '<b>x</b>' })).toBe('<b>x</b>');
    expect(toastNoticeText({ key: 'n.title', params: { name: 'Ana' } })).toBe('Hello Ana');
    expect(toastNoticeText({ key: 'n.count', params: { n: 2 } })).toBe('2 items, 2 again, {missing}');
    expect(toastNoticeText({ key: 'absent.key' })).toBe('absent.key');
    expect(toastNoticeText(null)).toBe('');
    expect(toastNoticeText(undefined)).toBe('');
  });

  it('does not read inherited properties as params', () => {
    expect(toastNoticeText({ key: 'n.title', params: {} })).toBe('Hello {name}');
    expect(toastNoticeText({ key: 'n.proto', params: {} })).toBe('{constructor}{toString}');
  });
});

describe('toastService.notice', () => {
  it('creates a toast keyed by the id, with the level mapped to the library type (info = default)', () => {
    for (const [level, type] of [['info', 'default'], ['success', 'success'], ['warning', 'warning'], ['error', 'error']] as const) {
      toastMock.isActive.mockReturnValue(false);
      toastService.notice({ id: `t-${level}`, level, title: { raw: 'T' } });
      expect(toastMock.mock.calls.at(-1)![1]).toMatchObject({ toastId: `t-${level}`, type });
    }
    expect(toastMock.update).not.toHaveBeenCalled();
  });

  it('updates the toast on screen instead of stacking a second one when the id is active', () => {
    toastMock.isActive.mockReturnValue(true);
    toastService.notice({ id: 'vx-interaction:/a', level: 'warning', title: { raw: 'Again' } });
    expect(toastMock.isActive).toHaveBeenCalledWith('vx-interaction:/a');
    expect(toastMock).not.toHaveBeenCalled();
    expect(toastMock.update).toHaveBeenCalledTimes(1);
    expect(toastMock.update.mock.calls[0][0]).toBe('vx-interaction:/a');
    expect(shown().markup).toContain('Again');
  });

  it('renders the title in bold, the translated body, and escapes raw HTML (text, never markup)', () => {
    toastMock.isActive.mockReturnValue(false);
    toastService.notice({ id: 'a', level: 'info', title: { key: 'n.title', params: { name: 'Ana' } }, body: { raw: '<img src=x onerror=alert(1)>' } });
    const { markup } = shown();
    expect(markup).toContain('<b>Hello Ana</b>');
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(markup).not.toContain('<img');
  });

  it('omits the body line when the body is empty or null', () => {
    toastMock.isActive.mockReturnValue(false);
    toastService.notice({ id: 'a', level: 'info', title: { raw: 'T' }, body: null });
    expect(shown().markup).toBe('<div class="vx-toast-notice"><b>T</b></div>');
    toastService.notice({ id: 'b', level: 'info', title: { raw: 'T' }, body: { raw: '' } });
    expect(shown().markup).toBe('<div class="vx-toast-notice"><b>T</b></div>');
  });

  it('without onOpen: not clickable, no click handler, no hint even if one is given', () => {
    toastMock.isActive.mockReturnValue(false);
    toastService.notice({ id: 'a', level: 'info', title: { raw: 'T' }, hint: { key: 'n.hint' } });
    const { options, markup } = shown();
    expect(options.closeOnClick).toBe(false);
    expect(options.onClick).toBeUndefined();
    expect(markup).not.toContain('vx-toast-notice--clickable');
    expect(markup).not.toContain('vx-toast-notice-hint');
    expect(markup).not.toContain('Click to open');
  });

  it('with onOpen: clickable, shows the hint, a click runs onOpen once and the library closes the toast (closeOnClick)', () => {
    toastMock.isActive.mockReturnValue(false);
    const onOpen = vi.fn();
    toastService.notice({ id: 'a', level: 'info', title: { raw: 'T' }, hint: { key: 'n.hint' }, onOpen });
    const { options, markup } = shown();
    expect(markup).toContain('class="vx-toast-notice vx-toast-notice--clickable"');
    expect(markup).toContain('<div class="vx-toast-notice-hint">Click to open</div>');
    expect(options.closeOnClick).toBe(true);
    expect(onOpen).not.toHaveBeenCalled();
    options.onClick!();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('with onOpen but no hint: clickable without a hint line', () => {
    toastMock.isActive.mockReturnValue(false);
    toastService.notice({ id: 'a', level: 'info', title: { raw: 'T' }, onOpen: () => undefined });
    expect(shown().markup).not.toContain('vx-toast-notice-hint');
  });

  it('an update carries the new onOpen and content (a repeat replaces the previous handler)', () => {
    toastMock.isActive.mockReturnValue(true);
    const first = vi.fn();
    const second = vi.fn();
    toastService.notice({ id: 'a', level: 'info', title: { raw: 'one' }, onOpen: first });
    toastService.notice({ id: 'a', level: 'info', title: { raw: 'two' }, onOpen: second });
    expect(toastMock.update).toHaveBeenCalledTimes(2);
    const { options, markup } = shown();
    expect(markup).toContain('two');
    options.onClick!();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it('leaves the four existing methods on ToastZone.addMessage, unchanged', () => {
    toastService.success('t', 'x');
    toastService.error('t', 'x');
    toastService.warning('t', 'x');
    toastService.info('t', 'x', { textParams: ['p'] });
    expect(addMessage.mock.calls.map((call) => call[2])).toEqual(['success', 'error', 'warning', 'info']);
    expect(addMessage.mock.calls[3]).toEqual(['t', 'x', 'info', { textParams: ['p'] }]);
    expect(toastMock).not.toHaveBeenCalled();
  });
});
