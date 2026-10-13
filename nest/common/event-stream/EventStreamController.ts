/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { BadRequestException, Controller, Headers, MessageEvent, Req, Res, Sse, UseInterceptors } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, ReplaySubject } from 'rxjs';
import { RequireAuthInterceptor, type AuthPrincipal } from '../auth';
import { NoTransportCrypt } from '../decorators/NoTransportCrypt';
import { EventStreamService } from './EventStreamService';
import { resolveExpiryMs } from './tokenExpiry';
import { SkipThrottleIfAvailable } from './skipThrottle';
import type { StreamFrame } from './types';

type AuthedRequest = Request & { user?: AuthPrincipal };

const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * `GET /api/v1/events/stream?topics=a,b`. Authentication is the global auth interceptor (Bearer token, admin key, or
 * local trust): without a principal the route answers 401. `@NoTransportCrypt()`: Nest sends the SSE headers with
 * the first message, which must not be encrypted.
 */
@Controller('api/v1/events')
@NoTransportCrypt()
@UseInterceptors(RequireAuthInterceptor)
@SkipThrottleIfAvailable()
export class EventStreamController {
  constructor(private readonly events: EventStreamService) {}

  @Sse('stream')
  async stream(
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
    @Headers('last-event-id') lastEventId?: string,
  ): Promise<Observable<MessageEvent>> {
    const principal = req.user;
    if (!principal) throw new BadRequestException('No authenticated principal');
    const topics = String(req.query['topics'] ?? '').split(',');
    const subject = new ReplaySubject<MessageEvent>();
    const sink = {
      send: (frame: StreamFrame) => {
        subject.next(toMessage(frame));
        this.dropIfBackedUp(res, sink);
      },
      end: () => subject.complete(),
    };
    const connection = await this.events.openConnection(principal, topics, sink, lastEventId);
    return new Observable<MessageEvent>((subscriber) => {
      const inner = subject.subscribe(subscriber);
      const timers = this.startTimers(principal, req, res, sink);
      return () => {
        timers.forEach((t) => clearTimeout(t));
        inner.unsubscribe();
        connection.close();
      };
    });
  }

  /**
   * A client that stops reading makes the socket buffer grow in server memory. Past `maxPendingBytes` the connection
   * is released and its socket destroyed; the client reconnects and receives `resync`.
   */
  private dropIfBackedUp(res: Response, sink: { end(): void }): void {
    if (res.destroyed || res.writableLength <= this.events.maxPendingBytes) return;
    sink.end();
    res.destroy();
  }

  private startTimers(principal: AuthPrincipal, req: Request, res: Response, sink: { send(f: StreamFrame): void; end(): void }): NodeJS.Timeout[] {
    const heartbeat = setInterval(() => {
      if (res.headersSent && !res.writableEnded) res.write(': ping\n\n');
      this.dropIfBackedUp(res, sink);
    }, this.events.heartbeatMs);
    const timers: NodeJS.Timeout[] = [heartbeat];
    const expiry = resolveExpiryMs(principal, req.headers.authorization);
    if (expiry !== null) {
      const delay = Math.min(Math.max(expiry - Date.now(), 0), MAX_TIMER_MS);
      timers.push(
        setTimeout(() => {
          sink.send({ name: 'expired', data: {} });
          sink.end();
        }, delay),
      );
    }
    timers.forEach((t) => t.unref());
    return timers;
  }
}

function toMessage(frame: StreamFrame): MessageEvent {
  return { type: frame.name, data: frame.data as object, id: frame.id };
}
