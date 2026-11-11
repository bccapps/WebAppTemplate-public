/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

/**
 * The SSRF guard as an attacker probes it (04 §14): address forms the URL parser normalizes (decimal, hex, short IPv4,
 * mapped / translated IPv6), user info, ports, and the bounds of an outbound socket (a target that trickles bytes or
 * streams without end). Local sockets only: no network.
 */
import { afterEach, describe, expect, it } from '@jest/globals';
import { createServer, type Server, type Socket } from 'net';
import type { AddressInfo } from 'net';
import { connect } from 'net';
import { assertReachable, guardedHttpsAgent, isBlockedAddress, limitSocket, NetGuardError, validateTargetUrl, type AddressGuard } from './netGuard';

const servers: Server[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function listen(onConnection: (socket: Socket) => void): Promise<number> {
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on('error', () => undefined);
    onConnection(socket);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

/** The error a socket was destroyed with (or `closed` without one), at most `ms` later. */
function outcomeOf(socket: Socket, ms: number): Promise<string> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('still open'), ms);
    socket.on('error', (error: Error) => {
      clearTimeout(timer);
      resolve(error instanceof NetGuardError ? error.code : `other:${error.name}`);
    });
    socket.on('close', () => setTimeout(() => resolve('closed'), 5));
  });
}

const privateGuard: AddressGuard = { allowPrivate: false, isBlocked: isBlockedAddress, resolve: async () => [{ address: '93.184.216.34', family: 4 }] };

describe('netGuard: address forms', () => {
  it('refuses literal private targets whatever their spelling once the URL parser has normalized them', async () => {
    for (const target of ['https://2130706433/', 'https://0x7f.1/', 'https://0177.0.0.1/', 'https://127.1/', 'https://[::1]/', 'https://[0:0:0:0:0:ffff:7f00:1]/', 'https://[::ffff:127.0.0.1]/', 'https://[::ffff:0:7f00:1]/', 'https://[64:ff9b::a9fe:a9fe]/', 'https://[2002:a9fe:a9fe::]/', 'https://169.254.169.254:8080/']) {
      await expect(assertReachable(new URL(target), privateGuard)).rejects.toMatchObject({ code: 'ADDRESS_REFUSED' });
    }
    await expect(assertReachable(new URL('https://[2606:4700:4700::1111]/'), privateGuard)).resolves.toBeUndefined();
  });

  it('blocks the IPv4-translated range (::ffff:0:0:0/96, SIIT) besides mapped, NAT64 and 6to4', () => {
    for (const address of ['::ffff:0:7f00:1', '::ffff:0:a00:1', '::ffff:0:808:808', '::ffff:7f00:1', '0:0:0:0:0:ffff:0:a9fe:a9fe']) expect(isBlockedAddress(address)).toBe(true);
    for (const address of ['8.8.8.8', '2001:4860:4860::8888', '::ffff:8.8.8.8']) expect(isBlockedAddress(address)).toBe(false);
  });

  it('refuses user info in a target URL; a port is allowed (the address decides, not the port)', async () => {
    expect(() => validateTargetUrl('https://user:pw@hooks.example.test/x', { admin: false })).toThrow('CREDENTIALS_IN_URL');
    expect(() => validateTargetUrl('https://user@hooks.example.test/x', { admin: true })).toThrow('CREDENTIALS_IN_URL');
    expect(validateTargetUrl('https://hooks.example.test:8443/x', { admin: false }).port).toBe('8443');
    await expect(assertReachable(new URL('https://hooks.example.test:22/'), { ...privateGuard, resolve: async () => [{ address: '10.0.0.8', family: 4 }] })).rejects.toMatchObject({ code: 'ADDRESS_REFUSED' });
  });

  it('a name with one private address among public ones is refused (no « first address » shortcut)', async () => {
    const mixed: AddressGuard = { ...privateGuard, resolve: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.1.1.1', family: 4 }] };
    await expect(assertReachable(new URL('https://mixed.example.test/'), mixed)).rejects.toMatchObject({ code: 'ADDRESS_REFUSED' });
  });
});

describe('netGuard: bounded outbound sockets', () => {
  it('destroys a socket that receives more than maxBytes (an endpoint streaming without end)', async () => {
    const port = await listen((socket) => {
      const chunk = Buffer.alloc(16 * 1024, 120);
      const pump = (): void => {
        while (!socket.destroyed && socket.write(chunk)) {
          /* keep the pipe full */
        }
        if (!socket.destroyed) socket.once('drain', pump);
      };
      pump();
    });
    const client = connect(port, '127.0.0.1');
    sockets.push(client);
    client.resume();
    limitSocket(client, { deadlineMs: 10_000, maxBytes: 64 * 1024 });
    expect(await outcomeOf(client, 5_000)).toBe('NETWORK');
    // Stopped right after the cap (one chunk of the socket at most), not at whatever the loopback had time to carry.
    expect(client.bytesRead).toBeLessThan(64 * 1024 + 256 * 1024);
  });

  it('destroys a socket past its deadline even while the target trickles bytes (an idle timeout would not fire)', async () => {
    const port = await listen((socket) => {
      const timer = setInterval(() => socket.write('.'), 20);
      socket.on('close', () => clearInterval(timer));
    });
    const client = connect(port, '127.0.0.1');
    sockets.push(client);
    client.resume();
    client.setTimeout(100); // an idle timeout, as `web-push` sets: never reached while bytes trickle
    const started = Date.now();
    limitSocket(client, { deadlineMs: 300, maxBytes: 1024 * 1024 });
    expect(await outcomeOf(client, 3_000)).toBe('TIMEOUT');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('the guarded https agent applies its limits to every connection it creates', async () => {
    const port = await listen(() => undefined); // accepts, never answers the TLS handshake
    const agent = guardedHttpsAgent({ allowPrivate: true, isBlocked: isBlockedAddress, resolve: async () => [{ address: '127.0.0.1', family: 4 }] }, { deadlineMs: 250, maxBytes: 1024 });
    const socket = agent.createConnection({ host: '127.0.0.1', port, servername: 'push.example.test' }) as unknown as Socket;
    sockets.push(socket);
    expect(await outcomeOf(socket, 3_000)).toBe('TIMEOUT');
    agent.destroy();
  });
});
