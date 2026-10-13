/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { useCallback } from 'react';
import '@/styles/theme_default.css';
import './LandingPage.css';
import { HeroVisual } from './HeroVisual';
import { I18nLabel } from '@/modules_shared/common/components/ui/label/I18nLabel';
import { Title } from '../Title';

// Placeholder feature cards — replace with the app's actual value proposition.
// `i18nPrefix` is a translation-key prefix (`${i18nPrefix}.title`/`.description` below), not a
// standalone lookup — named away from `id` since the i18n-check script's guarded regex flags any
// `id: "dotted.string"` as a direct translation reference, which produced false "missing key"
// reports for these (the real `custom.landing.feature.N.title/.description` keys already exist).
const features = [
  { i18nPrefix: 'custom.landing.feature.1' },
  { i18nPrefix: 'custom.landing.feature.2' },
  { i18nPrefix: 'custom.landing.feature.3' },
];

interface LandingPageProps {
  onLaunch?: () => void;
}

export function LandingPage({ onLaunch }: LandingPageProps) {
  const handleLaunch = useCallback(() => {
    if (onLaunch) {
      onLaunch();
    } else if (typeof window !== 'undefined') {
      window.location.href = '/app';
    }
  }, [onLaunch]);

  return (
    <div className="landing-page">
      <div className="landing-background-orbit" />
      <div className="landing-background-grid" />
      <header className="lp-header">
        <div className="lp-logo">
          <img src="/favicon.svg" alt="Logo" className="lp-logo-img" />
          <Title className="lp-logo-title" />
        </div>
        <button type="button" className="lp-cta" onClick={handleLaunch} aria-label="Launch the application">
          <I18nLabel id="custom.landing.hero.cta" />
        </button>
      </header>

      <main>
        <section className="lp-hero" id="hero">
          <div className="hero-content">
            <p className="hero-eyebrow">
              <I18nLabel id="custom.landing.hero.eyebrow" />
            </p>
            <h1>
              <I18nLabel id="custom.landing.hero.title" />
            </h1>
            <p className="hero-subtitle">
              <I18nLabel id="custom.landing.hero.subtitle" />
            </p>
            <div className="hero-actions">
              <button
                type="button"
                className="lp-cta primary"
                onClick={handleLaunch}
                aria-label="Launch the application"
              >
                <I18nLabel id="custom.landing.hero.cta" />
              </button>
            </div>
          </div>
          <HeroVisual />
        </section>

        <section className="lp-section" id="features">
          <div className="pillars">
            {features.map((feature) => (
              <article key={feature.i18nPrefix}>
                <h3>
                  <I18nLabel id={`${feature.i18nPrefix}.title`} />
                </h3>
                <p>
                  <I18nLabel id={`${feature.i18nPrefix}.description`} />
                </p>
              </article>
            ))}
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <div>
          <Title />
          <p>
            <I18nLabel id="custom.landing.footer.tagline" />
          </p>
        </div>
        <p className="footer-meta">© {new Date().getFullYear()} <I18nLabel id="custom.app.footer" /></p>
      </footer>
    </div>
  );
}

export default LandingPage;
