/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { lastValueFrom, of } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TransportCryptInterceptor } from './TransportCryptInterceptor';
import { NoTransportCrypt } from '../decorators/NoTransportCrypt';
import type { CryptService } from '../services/CryptService';
import type { CryptSessionService } from '../services/CryptSessionService';
import type { ConfigurationService } from '../services/ConfigurationService';
import {
  TRANSPORT_ACCEPT_ENCODING_HEADER,
  TRANSPORT_ENCODING_DEFLATE,
  TRANSPORT_ENCODING_IDENTITY,
  TRANSPORT_ENCRYPTED_HEADER,
  TRANSPORT_PAYLOAD_VERSION,
  TRANSPORT_PAYLOAD_VERSION_LEGACY,
  TRANSPORT_SESSION_HEADER,
  TRANSPORT_VERSION_HEADER,
} from '../constants/crypt.constants';

// Real classes (not mocks) so `@NoTransportCrypt()` metadata is genuinely attached via
// Reflect, and a real `Reflector` instance below reads it exactly like production code —
// see PERFORMANCE_PLAN.md §2.0 (decision C).
class FakeExemptController {
  @NoTransportCrypt()
  exemptRoute(): void {}
}
class FakeEncryptedController {
  encryptedRoute(): void {}
}

describe('TransportCryptInterceptor — deflate negotiation (PERFORMANCE_PLAN.md §2.3)', () => {
  const body = { hello: 'world' };
  const sessionKey = Buffer.alloc(32, 7);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type AnyMock = Record<string, any>;
  type FakeResponse = { writableEnded: boolean; headersSent: boolean; setHeader: ReturnType<typeof jest.fn> };

  let cryptService: AnyMock;
  let cryptSessionService: AnyMock;
  let configurationService: AnyMock;
  let interceptor: TransportCryptInterceptor;

  const buildContext = (
    headers: Record<string, string>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    routeHandler: (...args: any[]) => unknown = FakeEncryptedController.prototype.encryptedRoute,
    routeClass: new (...args: unknown[]) => unknown = FakeEncryptedController,
  ): { context: ExecutionContext; response: FakeResponse } => {
    const response: FakeResponse = { writableEnded: false, headersSent: false, setHeader: jest.fn() };
    const request = { headers };
    const context = {
      getType: () => 'http',
      getHandler: () => routeHandler,
      getClass: () => routeClass,
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as unknown as ExecutionContext;
    return { context, response };
  };

  const handler: CallHandler = { handle: () => of(body) };

  beforeEach(() => {
    delete process.env.DISABLE_TRANSPORT_CRYPTO;
    cryptService = {
      encryptForTransport: jest.fn<(...args: unknown[]) => unknown>().mockReturnValue('encrypted-payload'),
    };
    cryptSessionService = {
      peekSession: jest
        .fn<() => Promise<{ key: Buffer; expiresAt: number } | null>>()
        .mockResolvedValue({ key: sessionKey, expiresAt: 0 }),
    };
    configurationService = { get: jest.fn<(...args: unknown[]) => unknown>().mockReturnValue(2048) };
    interceptor = new TransportCryptInterceptor(
      cryptService as unknown as CryptService,
      cryptSessionService as unknown as CryptSessionService,
      configurationService as unknown as ConfigurationService,
      new Reflector(),
    );
  });

  it('emits the legacy v1 format, uncompressed, when the client sends no capability header (old cached bundle)', async () => {
    const { context, response } = buildContext({ [TRANSPORT_SESSION_HEADER]: 'sess-1' });
    await lastValueFrom(interceptor.intercept(context, handler));

    expect(cryptService.encryptForTransport).toHaveBeenCalledWith(
      body,
      sessionKey,
      expect.objectContaining({ legacy: true, deflate: false }),
    );
    expect(response.setHeader).toHaveBeenCalledWith(TRANSPORT_VERSION_HEADER, TRANSPORT_PAYLOAD_VERSION_LEGACY);
  });

  it('emits v2 without compression when the client announces v2 support but not deflate (no DecompressionStream)', async () => {
    const { context, response } = buildContext({
      [TRANSPORT_SESSION_HEADER]: 'sess-1',
      [TRANSPORT_ACCEPT_ENCODING_HEADER]: TRANSPORT_ENCODING_IDENTITY,
    });
    await lastValueFrom(interceptor.intercept(context, handler));

    expect(cryptService.encryptForTransport).toHaveBeenCalledWith(
      body,
      sessionKey,
      expect.objectContaining({ legacy: false, deflate: false }),
    );
    expect(response.setHeader).toHaveBeenCalledWith(TRANSPORT_VERSION_HEADER, TRANSPORT_PAYLOAD_VERSION);
  });

  it('emits v2 with deflate offered when the client announces full support, using the configured threshold', async () => {
    const { context } = buildContext({
      [TRANSPORT_SESSION_HEADER]: 'sess-1',
      [TRANSPORT_ACCEPT_ENCODING_HEADER]: TRANSPORT_ENCODING_DEFLATE,
    });
    await lastValueFrom(interceptor.intercept(context, handler));

    expect(configurationService.get).toHaveBeenCalledWith('common_transport_deflate_threshold');
    expect(cryptService.encryptForTransport).toHaveBeenCalledWith(
      body,
      sessionKey,
      expect.objectContaining({ legacy: false, deflate: true, thresholdBytes: 2048 }),
    );
  });

  it('falls back to the default threshold when the config value is not yet seeded', async () => {
    configurationService.get.mockReturnValue(undefined);
    const { context } = buildContext({
      [TRANSPORT_SESSION_HEADER]: 'sess-1',
      [TRANSPORT_ACCEPT_ENCODING_HEADER]: TRANSPORT_ENCODING_DEFLATE,
    });
    await lastValueFrom(interceptor.intercept(context, handler));

    expect(cryptService.encryptForTransport).toHaveBeenCalledWith(
      body,
      sessionKey,
      expect.objectContaining({ thresholdBytes: 1024 }),
    );
  });

  it('passes requests through untouched when there is no session id', async () => {
    const { context } = buildContext({});
    const result = await lastValueFrom(interceptor.intercept(context, handler));
    expect(result).toBe(body);
    expect(cryptService.encryptForTransport).not.toHaveBeenCalled();
  });

  describe('@NoTransportCrypt() exemption (PERFORMANCE_PLAN.md §2.0 — decision C)', () => {
    it('returns the plaintext body, with no x-crypt-encrypted header, on an exempted route even with a session header present', async () => {
      const { context, response } = buildContext(
        { [TRANSPORT_SESSION_HEADER]: 'sess-1' },
        FakeExemptController.prototype.exemptRoute,
        FakeExemptController,
      );
      const result = await lastValueFrom(interceptor.intercept(context, handler));

      expect(result).toBe(body);
      expect(cryptService.encryptForTransport).not.toHaveBeenCalled();
      expect(response.setHeader).not.toHaveBeenCalledWith(TRANSPORT_ENCRYPTED_HEADER, '1');
      // The exemption short-circuits before the session lookup — no Redis round-trip
      // for these routes (see interceptor comment on the `isExempt` branch).
      expect(cryptSessionService.peekSession).not.toHaveBeenCalled();
    });

    it('still encrypts (x-crypt-encrypted header set) on a non-exempted route with the same session header', async () => {
      const { context, response } = buildContext(
        { [TRANSPORT_SESSION_HEADER]: 'sess-1' },
        FakeEncryptedController.prototype.encryptedRoute,
        FakeEncryptedController,
      );
      const result = await lastValueFrom(interceptor.intercept(context, handler));

      expect(result).toEqual({ payload: 'encrypted-payload' });
      expect(cryptService.encryptForTransport).toHaveBeenCalled();
      expect(response.setHeader).toHaveBeenCalledWith(TRANSPORT_ENCRYPTED_HEADER, '1');
      expect(cryptSessionService.peekSession).toHaveBeenCalledWith('sess-1');
    });
  });
});
