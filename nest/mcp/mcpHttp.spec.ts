/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { McpServer } from '@modelcontextprotocol/server';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { MCP_JSON_RPC_VERSION, rejectMcp, rejectMcpMethod, serveMcp } from './mcpHttp';
import { mcpTextResult } from './mcpResults';

const MODERN = '2026-07-28';
const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': MODERN,
  'io.modelcontextprotocol/clientInfo': { name: 'spec', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

/** One server per request, as the apps do; the "who" is read from the x-who header to prove servers never cross. */
function buildServer(who: string): McpServer {
  const server = new McpServer({ name: 'spec', version: '1.0.0' });
  server.registerTool('whoami', { description: 'Echoes the principal this server was built for.', inputSchema: z.object({ n: z.number().optional() }) }, async () => mcpTextResult({ who }));
  return server;
}

let http: Server;
let url: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.post('/mcp', (req, res) => void serveMcp(req, res, buildServer(String(req.headers['x-who'] ?? 'anonymous'))));
  app.get('/mcp', (_req, res) => rejectMcpMethod(res));
  app.get('/reject', (_req, res) => rejectMcp(res, 401, 'denied'));
  await new Promise<void>((resolve) => { http = app.listen(0, '127.0.0.1', () => resolve()); });
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterAll(async () => { await new Promise((resolve) => http.close(() => resolve(undefined))); });

/** Decoded JSON-RPC reply; the shape is asserted field by field in the tests. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function post(headers: Record<string, string>, body: unknown): Promise<{ status: number; type: string; json: Json }> {
  const res = await fetch(`${url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, type: res.headers.get('content-type') ?? '', json: text.startsWith('{') ? JSON.parse(text) : text };
}

const modern = (method: string, params: Record<string, unknown>, headers: Record<string, string> = {}) =>
  post({ 'mcp-protocol-version': MODERN, 'mcp-method': method, ...headers }, { jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: MODERN_META } });
const legacy = (version: string, method: string, params: Record<string, unknown>, headers: Record<string, string> = {}) =>
  post({ 'mcp-protocol-version': version, ...headers }, { jsonrpc: '2.0', id: 1, method, params });

describe('serveMcp', () => {
  it('serves a 2026-07-28 tools/list and tools/call', async () => {
    const list = await modern('tools/list', {});
    expect(list.status).toBe(200);
    expect(list.json.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['whoami']);
    const call = await modern('tools/call', { name: 'whoami', arguments: {} }, { 'mcp-name': 'whoami', 'x-who': 'alice' });
    expect(call.status).toBe(200);
    expect(JSON.parse(call.json.result.content[0].text)).toEqual({ who: 'alice' });
  });

  it.each(['2025-11-25', '2025-06-18', '2025-03-26'])('serves a %s initialize as a plain JSON body (not SSE)', async (version) => {
    const init = await legacy(version, 'initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'spec', version: '1' } });
    expect(init.status).toBe(200);
    expect(init.type).toContain('application/json');
    expect(init.json.result.serverInfo.name).toBe('spec');
  });

  it('serves 2025-11-25 tools/list and tools/call as plain JSON', async () => {
    const list = await legacy('2025-11-25', 'tools/list', {});
    expect(list.type).toContain('application/json');
    expect(list.json.result.tools).toHaveLength(1);
    const call = await legacy('2025-11-25', 'tools/call', { name: 'whoami', arguments: {} }, { 'x-who': 'bob' });
    expect(call.type).toContain('application/json');
    expect(JSON.parse(call.json.result.content[0].text)).toEqual({ who: 'bob' });
  });

  it('binds each request to its own server: concurrent callers of both eras never see each other', async () => {
    const calls = await Promise.all(
      ['a', 'b', 'c', 'd'].map((who, index) =>
        index % 2 === 0
          ? modern('tools/call', { name: 'whoami', arguments: {} }, { 'mcp-name': 'whoami', 'x-who': who })
          : legacy('2025-11-25', 'tools/call', { name: 'whoami', arguments: {} }, { 'x-who': who }),
      ),
    );
    expect(calls.map((call) => JSON.parse(call.json.result.content[0].text).who)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('rejects an unknown tool with a protocol error (-32602), not an isError result', async () => {
    const modernUnknown = await modern('tools/call', { name: 'nope', arguments: {} }, { 'mcp-name': 'nope' });
    expect(modernUnknown.json.error?.code).toBe(-32602);
    const legacyUnknown = await legacy('2025-11-25', 'tools/call', { name: 'nope', arguments: {} });
    expect(legacyUnknown.json.error?.code).toBe(-32602);
  });
});

describe('rejectMcp / rejectMcpMethod', () => {
  it('rejectMcp answers a JSON-RPC error body with the given status', async () => {
    const res = await fetch(`${url}/reject`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ jsonrpc: MCP_JSON_RPC_VERSION, error: { code: -32000, message: 'denied' }, id: null });
  });

  it('rejectMcpMethod answers 405 with Allow: POST', async () => {
    const res = await fetch(`${url}/mcp`);
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
    expect((await res.json()).error.code).toBe(-32000);
  });
});
