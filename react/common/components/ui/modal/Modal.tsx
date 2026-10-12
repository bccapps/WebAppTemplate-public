/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface ModalProps {
  title: string
  description?: string
  isOpen: boolean
  onClose: () => void
  panelClassName?: string
  children: ReactNode
  headerActions?: ReactNode
}

export default function Modal({ title, description, isOpen, onClose, panelClassName, children, headerActions }: ModalProps) {
  if (!isOpen) {
    return null
  }

  return createPortal(
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div className={["modal-panel", panelClassName].filter(Boolean).join(' ')}>
        <div className="modal-header">
          <div>
            <h3 id="modal-title">{title}</h3>
            {description ? <p className="subtext">{description}</p> : null}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            {headerActions ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>{headerActions}</div>
            ) : null}
            <button type="button" className="ghost-btn" onClick={onClose}>
              ×
            </button>
          </div>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  )
}
