/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * The bot token is part of every Bot API URL, and `common`'s `throttledFetchJson` logs the message of a failed fetch.
 * Every method of `TelegramBotClient` is driven through every failure mode (network error of undici, a polyfill error
 * quoting the URL, an abort quoting it, a real timeout, non-2xx bodies echoing the token, invalid JSON, a body that
 * fails mid-read): neither the token, the webhook secret, nor the text sent may appear in ANY log call (Nest logger and
 * console) nor in the returned value. Fake timers make the retries and the backoff instant.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Logger, type LoggerService } from '@nestjs/common';
import { resetThrottleBuckets } from '../../../common/utils/throttledFetch';
import { BotApiTransportError, botApiTransport, TelegramBotClient } from './TelegramBotClient';

const TOKEN = '424242:SECRET_part_of_the_token_0123456789';
const WEBHOOK_SECRET = 'whk_SECRET_webhook_value_0123456789abcdefgh';
const TEXT = 'PRIVATE message text 42';
const LEAKS = ['SECRET_part_of_the_token', WEBHOOK_SECRET, TEXT, 'api.telegram.org/bot'];

const lines: string[] = [];
class CapturingLogger implements LoggerService {
  log(...parts: unknown[]): void {
    lines.push(`log ${parts.map(String).join(' ')}`);
  }
  error(...parts: unknown[]): void {
    lines.push(`error ${parts.map(String).join(' ')}`);
  }
  warn(...parts: unknown[]): void {
    lines.push(`warn ${parts.map(String).join(' ')}`);
  }
  debug(...parts: unknown[]): void {
    lines.push(`debug ${parts.map(String).join(' ')}`);
  }
  verbose(...parts: unknown[]): void {
    lines.push(`verbose ${parts.map(String).join(' ')}`);
  }
}

type FetchMock = (url: string, init: RequestInit) => Promise<Response>;

const failingStream = (message: string): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"ok":tr'));
      controller.error(new Error(message));
    },
  });

/** Each way a Bot API call can fail, every one of them quoting the token where a real failure could. */
const MODES: Array<[string, FetchMock]> = [
  ['network error (undici, cause quoting the URL)', async (url) => Promise.reject(new TypeError('fetch failed', { cause: new Error(`getaddrinfo ENOTFOUND ${url}`) }))],
  ['network error (polyfill message quoting the URL)', async (url) => Promise.reject(new Error(`request to ${url} failed, reason: ECONNRESET`))],
  ['abort quoting the URL', async (url) => Promise.reject(Object.assign(new Error(`The operation was aborted: ${url}`), { name: 'AbortError' }))],
  [
    'timeout (the call never answers)',
    (url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error(`This operation was aborted ${url}`), { name: 'AbortError' })));
      }),
  ],
  ['HTTP 401 whose body echoes the token', async () => new Response(JSON.stringify({ ok: false, error_code: 401, description: `Unauthorized ${TOKEN} ${WEBHOOK_SECRET}` }), { status: 401 })],
  ['HTTP 502 (retried) whose body echoes the token', async () => new Response(JSON.stringify({ ok: false, description: `Bad Gateway ${TOKEN}` }), { status: 502, headers: { 'retry-after': '1' } })],
  ['invalid JSON echoing the token', async () => new Response(`<html>${TOKEN} ${TEXT}</html>`, { status: 200 })],
  ['a body that fails mid-read', async (url) => new Response(failingStream(`terminated ${url}`), { status: 200 })],
];

const CALLS: Array<[string, (client: TelegramBotClient) => Promise<unknown>]> = [
  ['getUpdates', (client) => client.getUpdates(TOKEN, '5')],
  ['sendMessage', (client) => client.sendMessage(TOKEN, '42', TEXT, { inline_keyboard: [[{ text: 'Approve', callback_data: 'ix:AAAAAAAAAAAA:0:BBBBBBBB' }]] })],
  ['editMessageText', (client) => client.editMessageText(TOKEN, '42', '7', TEXT)],
  ['answerCallbackQuery', (client) => client.answerCallbackQuery(TOKEN, 'cbq-1', TEXT)],
  ['getMe', (client) => client.getMe(TOKEN)],
  ['setWebhook', (client) => client.setWebhook(TOKEN, 'https://app.test/api/v1/interaction/telegram/webhook/u1', WEBHOOK_SECRET)],
  ['deleteWebhook', (client) => client.deleteWebhook(TOKEN)],
];

/** Runs a call to its end under fake timers (timeouts, retries and backoff elapse instantly). */
async function settle<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  void promise.finally(() => {
    done = true;
  });
  for (let i = 0; i < 50 && !done; i += 1) await jest.advanceTimersByTimeAsync(10_000);
  return promise;
}

function expectNoLeak(...where: string[]): void {
  const text = where.join('\n');
  for (const leak of LEAKS) expect(text).not.toContain(leak);
}

beforeEach(() => {
  lines.length = 0;
  Logger.overrideLogger(new CapturingLogger());
  for (const name of ['log', 'info', 'warn', 'error', 'debug'] as const) jest.spyOn(console, name).mockImplementation((...parts: unknown[]) => void lines.push(`console.${name} ${parts.map(String).join(' ')}`));
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
  resetThrottleBuckets();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  resetThrottleBuckets();
});

describe('TelegramBotClient: no token, webhook secret or text in any log or result, whatever fails', () => {
  for (const [mode, mock] of MODES) {
    for (const [method, call] of CALLS) {
      it(`${method} — ${mode}`, async () => {
        const urls: string[] = [];
        jest.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
          urls.push(String(input));
          return mock(String(input), init ?? {});
        });
        const result = await settle(call(new TelegramBotClient()));
        expect(urls.length).toBeGreaterThanOrEqual(1);
        // The token really is in the URL the transport receives: the absence below is not by luck.
        expect(urls.every((url) => url.includes(`/bot${TOKEN}/`))).toBe(true);
        expect(result).toMatchObject({ ok: false });
        expect(typeof (result as { status: unknown }).status).toBe('number');
        expectNoLeak(JSON.stringify(result), ...lines);
        // Not vacuous: a transport failure IS logged by throttledFetchJson (when the call is retried), with a code only.
        const warned = lines.filter((line) => line.includes('fetch failed'));
        for (const line of warned) expect(line).toMatch(/fetch failed \((NETWORK|TIMEOUT)\)/);
      });
    }
  }

  it('the transport turns every fetch or body error into a code (TIMEOUT once aborted, NETWORK otherwise)', async () => {
    const url = `https://api.telegram.org/bot${TOKEN}/getMe`;
    const transport = botApiTransport({ method: 'POST', body: JSON.stringify({ secret_token: WEBHOOK_SECRET }) });
    for (const [, mock] of MODES.filter(([mode]) => mode.startsWith('network') || mode.startsWith('abort'))) {
      jest.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request, init?: RequestInit) => mock(String(input), init ?? {}));
      const error = await transport(url, new AbortController().signal).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(BotApiTransportError);
      expect((error as Error).message).toBe('NETWORK');
      expectNoLeak(String(error), JSON.stringify(error), String((error as Error).stack ?? ''));
    }
    const aborted = new AbortController();
    aborted.abort();
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input: string | URL | Request) => Promise.reject(Object.assign(new Error(`aborted ${String(input)}`), { name: 'AbortError' })));
    await expect(transport(url, aborted.signal)).rejects.toMatchObject({ message: 'TIMEOUT', code: 'TIMEOUT' });
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(`not json ${TOKEN}`, { status: 200, headers: { 'retry-after': '3' } }));
    expect(await transport(url, new AbortController().signal)).toEqual({ status: 200, body: null, retryAfter: '3' });
  });

  it('a token that does not have the Bot API shape never reaches fetch', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch');
    const client = new TelegramBotClient();
    for (const bad of ['', 'no-colon', `${TOKEN}/../x`, `${TOKEN} `, '1:a/b']) expect(await client.getMe(bad)).toEqual({ ok: false, status: 401 });
    expect(fetch).not.toHaveBeenCalled();
  });
});
