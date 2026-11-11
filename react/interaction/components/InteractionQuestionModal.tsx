/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatCountdown, secondsLeft } from '../pure/text';
import { useHasInteractionStepUp, useInteractionTicket } from '../hooks/interactionHooks';
import { ixLabel } from '../services/labels';
import { IxLabel, IxText } from './IxText';
import '../styles/tokens.css';
import '../styles/interaction.css';

interface InteractionQuestionModalProps {
  ticketId: string;
  onClose: () => void;
}

/** Ticks once a second while mounted. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * A question (04 §10.2): summary, fields, actions (an action this channel may not answer is shown disabled with the
 * channels that can), countdown to the expiry. While an answer is sent: loading, close blocked, background blurred.
 * Once closed elsewhere (another tab, Telegram, expiry), the outcome is shown instead of the actions.
 */
export function InteractionQuestionModal({ ticketId, onClose }: InteractionQuestionModalProps) {
  const { ticket, answer, answering, error } = useInteractionTicket(ticketId);
  const hasStepUp = useHasInteractionStepUp();
  const now = useNow();
  if (!ticket) return null;
  const left = secondsLeft(ticket.expiresAt, now);
  const open = ticket.status === 'open' && left > 0;
  // A `freshProof` question needs the app's step-up UI (lot S); without one it cannot be answered here.
  const stepUpMissing = ticket.freshProofRequired && !hasStepUp;
  const close = () => {
    if (!answering) onClose();
  };
  return createPortal(
    <div className="ix-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="ix-modal-title" aria-busy={answering}>
      <div className="ix-modal">
        <div className="ix-modal-header">
          <h3 id="ix-modal-title">
            <IxText text={ticket.summary.title} />
          </h3>
          <button type="button" className="ix-modal-close" onClick={close} disabled={answering} aria-label={ixLabel('interaction.modal.close')}>
            ×
          </button>
        </div>
        {ticket.summary.body ? (
          <p className="ix-modal-body">
            <IxText text={ticket.summary.body} />
          </p>
        ) : null}
        {ticket.summary.fields?.length ? (
          <dl className="ix-modal-fields">
            {ticket.summary.fields.map((field, index) => (
              <div key={index}>
                <dt>
                  <IxText text={field.label} />
                </dt>
                <dd>{field.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {open ? (
          <>
            <p className={left < 60 ? 'ix-countdown ix-countdown--urgent' : 'ix-countdown'}>
              <IxLabel id="interaction.modal.expiresIn" params={{ time: formatCountdown(left) }} />
            </p>
            {ticket.freshProofRequired ? (
              <p className="ix-modal-hint">
                <IxLabel id="interaction.modal.freshProof" />
              </p>
            ) : null}
            {stepUpMissing ? (
              <p className="ix-modal-error" role="alert">
                <IxLabel id="interaction.modal.stepUpUnavailable" />
              </p>
            ) : null}
            <div className="ix-modal-actions">
              {ticket.actions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  className={`ix-action ix-action--${action.style}`}
                  disabled={answering || !action.allowedHere || stepUpMissing}
                  title={action.allowedHere ? undefined : ixLabel('interaction.modal.answerElsewhere', { channels: ticket.answerableFrom.join(', ') })}
                  onClick={() => void answer(action.id)}
                >
                  <IxText text={action.label} />
                </button>
              ))}
            </div>
            {ticket.actions.some((action) => !action.allowedHere) ? (
              <p className="ix-modal-hint">
                <IxLabel id="interaction.modal.answerElsewhere" params={{ channels: ticket.answerableFrom.join(', ') }} />
              </p>
            ) : null}
            {answering ? (
              <p className="ix-modal-hint" role="status">
                <IxLabel id="interaction.modal.sending" />
              </p>
            ) : null}
          </>
        ) : (
          <p className="ix-modal-outcome" role="status">
            <IxLabel id={`interaction.modal.outcome.${ticket.status === 'open' ? 'expired' : ticket.status}`} params={{ via: ticket.answeredVia ?? '' }} />
          </p>
        )}
        {error ? (
          <p className="ix-modal-error" role="alert">
            <IxLabel id={`interaction.errors.${error}`} />
          </p>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
