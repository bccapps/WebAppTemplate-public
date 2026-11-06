/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler, isLegacyRequest } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport, toNodeHandler, toWebRequest } from '@modelcontextprotocol/node';
import type { Request, Response } from 'express';

export const MCP_JSON_RPC_VERSION = '2.0';

/**
 * Serves ONE stateless MCP request with a server built for this request only (never share a server across
 * requests: tools are bound to the caller's principal). The caller authenticates first; this does no auth,
 * Host or Origin check.
 *
 * One endpoint, both eras: a 2026-07-28 request goes through the SDK handler (always a JSON reply; `subscriptions/listen` is refused in-band, no stream is ever opened),
 * a 2025-era request (`initialize`, 2025-11-25, 2025-06-18, 2025-03-26) through a stateless Streamable HTTP
 * transport with `enableJsonResponse`, i.e. a plain JSON body like the v1 SDK gave (the SDK's own legacy fallback
 * would answer those with SSE). `req.body` (already parsed by the app's Express, `rawBody` / `configureHttpApp` untouched) is passed along: the Node stream is not read.
 */
export async function serveMcp(req: Request, res: Response, server: McpServer): Promise<void> {
  const body = req.body;
  const closers: Array<() => Promise<unknown>> = [() => server.close()];
  res.on('close', () => {
    for (const close of closers) close().catch(() => undefined);
  });
  // A stateless endpoint never pushes a change: do not invite clients to listen (the SDK advertises it by default).
  if (server.server.getCapabilities().tools) server.server.registerCapabilities({ tools: { listChanged: false } });
  const probe = await toWebRequest(req, body);
  if (await isLegacyRequest(probe, body)) {
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    closers.push(() => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
    return;
  }
  const handler = createMcpHandler(() => server, { legacy: 'reject', responseMode: 'json', maxSubscriptions: 0 });
  closers.push(() => handler.close());
  await toNodeHandler(handler)(req, res, body);
}

/** JSON-RPC error body with HTTP status, `id: null`, code -32000 (the shape the apps' MCP clients already receive). */
export function rejectMcp(res: Response, status: number, message: string): void {
  res.status(status).json({ jsonrpc: MCP_JSON_RPC_VERSION, error: { code: -32000, message }, id: null });
}

/** 405 with `Allow: POST`: a stateless server has no server-initiated stream (GET) and no session to end (DELETE). */
export function rejectMcpMethod(res: Response): void {
  res.setHeader('Allow', 'POST');
  rejectMcp(res, 405, 'Method not allowed: this MCP server is stateless, use POST');
}
