/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { describe, expect, it, vi } from 'vitest';
import { answerWithStepUp, stepUpRequestOf } from './stepUp';

const required = (details: Record<string, unknown> | null) => ({ code: 'STEP_UP_REQUIRED', status: 403, details });

describe('stepUpRequestOf', () => {
  it('reads the methods and purpose of the server rejection', () => {
    expect(stepUpRequestOf(required({ methods: ['totp', 'email_code', 3], purpose: 'interaction.ticket:t1' }))).toEqual({ methods: ['totp', 'email_code'], purpose: 'interaction.ticket:t1' });
    expect(stepUpRequestOf(required(null))).toEqual({ methods: [], purpose: null });
    expect(stepUpRequestOf(required({ methods: 'totp' }))).toEqual({ methods: [], purpose: null });
  });

  it('is null for any other failure', () => {
    expect(stepUpRequestOf({ code: 'ALREADY_ANSWERED', status: 409, details: null })).toBeNull();
    expect(stepUpRequestOf(new Error('x'))).toBeNull();
    expect(stepUpRequestOf(null)).toBeNull();
  });
});

describe('answerWithStepUp', () => {
  it('answers without asking the handler when the server does not require a proof', async () => {
    const send = vi.fn().mockResolvedValue({});
    const handler = vi.fn();
    expect(await answerWithStepUp({ ticketId: 't1', fallbackPurpose: null, handler, send })).toBe('answered');
    expect(send).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
  });

  it('passes the server methods and purpose to the handler, then answers with its proof', async () => {
    const send = vi.fn().mockRejectedValueOnce(required({ methods: ['wallet', 'totp'], purpose: 'interaction.ticket:t1' })).mockResolvedValueOnce({});
    const handler = vi.fn().mockResolvedValue('proof-9');
    expect(await answerWithStepUp({ ticketId: 't1', fallbackPurpose: 'ticket-purpose', handler, send })).toBe('answered');
    expect(handler).toHaveBeenCalledWith({ ticketId: 't1', purpose: 'interaction.ticket:t1', methods: ['wallet', 'totp'] });
    expect(send).toHaveBeenNthCalledWith(1, undefined);
    expect(send).toHaveBeenNthCalledWith(2, 'proof-9');
  });

  it('falls back to the purpose of the ticket when the rejection carries none', async () => {
    const send = vi.fn().mockRejectedValueOnce(required({ methods: ['totp'] })).mockResolvedValueOnce({});
    const handler = vi.fn().mockResolvedValue('p');
    await answerWithStepUp({ ticketId: 't1', fallbackPurpose: 'ticket-purpose', handler, send });
    expect(handler).toHaveBeenCalledWith({ ticketId: 't1', purpose: 'ticket-purpose', methods: ['totp'] });
  });

  it('is cancelled, without a second call, when the user gives up', async () => {
    const send = vi.fn().mockRejectedValue(required({ methods: ['totp'], purpose: 'p' }));
    expect(await answerWithStepUp({ ticketId: 't1', fallbackPurpose: null, handler: vi.fn().mockResolvedValue(null), send })).toBe('cancelled');
    expect(send).toHaveBeenCalledOnce();
  });

  it('rethrows STEP_UP_REQUIRED without a handler (the modal shows the label)', async () => {
    const error = required({ methods: ['totp'], purpose: 'p' });
    await expect(answerWithStepUp({ ticketId: 't1', fallbackPurpose: null, handler: null, send: vi.fn().mockRejectedValue(error) })).rejects.toBe(error);
  });

  it('rethrows other failures and a rejected proof, and never asks twice', async () => {
    const other = { code: 'ALREADY_ANSWERED', status: 409, details: null };
    const handler = vi.fn();
    await expect(answerWithStepUp({ ticketId: 't1', fallbackPurpose: 'p', handler, send: vi.fn().mockRejectedValue(other) })).rejects.toBe(other);
    expect(handler).not.toHaveBeenCalled();

    const rejected = required({ methods: ['totp'], purpose: 'p' });
    const send = vi.fn().mockRejectedValue(rejected);
    const again = vi.fn().mockResolvedValue('bad-proof');
    await expect(answerWithStepUp({ ticketId: 't1', fallbackPurpose: null, handler: again, send })).rejects.toBe(rejected);
    expect(again).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('uses a proof the caller already holds without asking the handler', async () => {
    const rejected = required({ methods: ['totp'], purpose: 'p' });
    const handler = vi.fn();
    await expect(answerWithStepUp({ ticketId: 't1', fallbackPurpose: 'p', proof: 'held', handler, send: vi.fn().mockRejectedValue(rejected) })).rejects.toBe(rejected);
    expect(handler).not.toHaveBeenCalled();
  });
});
