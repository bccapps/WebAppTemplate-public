/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * The REAL `web-push` library behind `WebPushSender` (skipped when it is not installed): it honours the guarded agent,
 * so a name that resolves to a public address at the check and to loopback at the connection (DNS rebinding) is
 * refused, and nothing reaches the network (the second resolution is loopback, refused before any connect).
 */
import { describe, expect, it } from '@jest/globals';
import { randomBytes } from 'crypto';
import { generateVapidKeys } from '../../adapters/ConfigVapidKeySource';
import { isBlockedAddress, type AddressGuard } from '../../utils/netGuard';
import { WebPushSender, type WebPushLibrary } from './WebPushSender';

const library = ((): WebPushLibrary | null => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(require.resolve('web-push')) as WebPushLibrary;
  } catch {
    return null;
  }
})();

class RebindingSender extends WebPushSender {
  resolutions = 0;
  protected override guard(): AddressGuard {
    return {
      allowPrivate: false,
      isBlocked: isBlockedAddress,
      resolve: async () => {
        this.resolutions += 1;
        return this.resolutions === 1 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }];
      },
    };
  }
  protected override library(): Promise<WebPushLibrary | null> {
    return Promise.resolve(library);
  }
}

(library ? describe : describe.skip)('WebPushSender with the real web-push library', () => {
  it('a name rebinding to loopback between the check and the connection is refused by the guarded agent', async () => {
    const sender = new RebindingSender();
    const vapid = generateVapidKeys();
    const target = { endpoint: 'https://rebind.example.test/push/x', p256dh: generateVapidKeys().publicKey, auth: randomBytes(16).toString('base64url') };
    const result = await sender.send(target, JSON.stringify({ t: 1 }), { ...vapid, subject: 'mailto:a@b.test' }, 3000);
    expect(result).toEqual({ ok: false, status: null, code: 'ADDRESS_REFUSED' });
    expect(sender.resolutions).toBe(2);
  });
});
