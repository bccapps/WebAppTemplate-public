/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import './LandingPage.css';

// Purely decorative placeholder visual — swap for a real product screenshot or illustration.
export const HeroVisual = () => (
  <div className="hero-visual" role="img" aria-hidden="true">
    <svg className="orbit" viewBox="0 0 320 320" aria-hidden="true">
      <defs>
        <linearGradient id="orbitGradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="var(--accent-light-color)" stopOpacity="0.6" />
          <stop offset="100%" stopColor="rgba(255,255,255,0.2)" />
        </linearGradient>
      </defs>
      <circle cx="160" cy="160" r="120" stroke="url(#orbitGradient)" strokeWidth="1.5" fill="none" strokeDasharray="6 8" />
      <circle cx="160" cy="160" r="70" stroke="rgba(255,255,255,0.2)" strokeWidth="1" fill="none" strokeDasharray="4 6" />
    </svg>
  </div>
);

export default HeroVisual;
