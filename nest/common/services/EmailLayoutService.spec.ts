/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { describe, expect, it, jest } from '@jest/globals';
import { BrandService } from './BrandService';
import { EmailLayoutService } from './EmailLayoutService';

const SITE_URL = 'https://example.com';

const buildBrandService = (): BrandService => {
  const config = {
    getDecryptedValue: jest.fn((key: string) => {
      const values: Record<string, string> = {
        common_brand_siteUrl: SITE_URL,
        common_brand_siteName: 'Example',
      };
      return values[key] ?? '';
    }),
  };
  return new BrandService(config as never);
};

const buildService = (): EmailLayoutService => {
  const localeService = { translate: jest.fn((key: string) => Promise.resolve(key)) } as never;
  return new EmailLayoutService(buildBrandService(), localeService);
};

describe('EmailLayoutService', () => {
  describe('reapplyChrome', () => {
    it('swaps the header and footer content without touching the frozen body between them', () => {
      const service = buildService();
      const frozen = service.wrap('<p>original body — never touched</p>', {
        headerHtml: '<p>old header</p>',
        footerHtml: '<p>old footer</p>',
      });

      const updated = service.reapplyChrome(frozen, {
        headerHtml: '<p>NEW header</p>',
        footerHtml: '<p>NEW footer</p>',
      });

      expect(updated).not.toBeNull();
      expect(updated).toContain('<p>NEW header</p>');
      expect(updated).toContain('<p>NEW footer</p>');
      expect(updated).not.toContain('old header');
      expect(updated).not.toContain('old footer');
      expect(updated).toContain('<p>original body — never touched</p>');
    });

    it('only rewrites the header when only the header changes', () => {
      const service = buildService();
      const frozen = service.wrap('<p>body</p>', {
        headerHtml: '<p>old header</p>',
        footerHtml: '<p>same footer</p>',
      });

      const updated = service.reapplyChrome(frozen, {
        headerHtml: '<p>NEW header</p>',
        footerHtml: '<p>same footer</p>',
      });

      expect(updated).toContain('<p>NEW header</p>');
      expect(updated).toContain('<p>same footer</p>');
      expect(updated).not.toContain('old header');
    });

    it('reapplies the header background color', () => {
      const service = buildService();
      const frozen = service.wrap('<p>body</p>', {
        headerHtml: '<p>header</p>',
        headerBackgroundColor: '#111111',
      });

      const updated = service.reapplyChrome(frozen, {
        headerHtml: '<p>header</p>',
        headerBackgroundColor: '#222222',
      });

      expect(updated).toContain('background:#222222;');
      expect(updated).not.toContain('background:#111111;');
    });

    it('returns null when the header/footer markers are missing (an email frozen before this feature shipped)', () => {
      const service = buildService();
      const legacyFrozenHtml = '<html><body><p>legacy render, no markers</p></body></html>';

      expect(service.reapplyChrome(legacyFrozenHtml, { headerHtml: '<p>NEW header</p>' })).toBeNull();
    });
  });

  describe('wrap — responsive images', () => {
    it('adds max-width:100%;height:auto to a body image with no style at all (RichTextEditor legacy content, no sizing)', () => {
      const service = buildService();
      const html = service.wrap('<img src="https://cdn.example.com/photo.png" alt="photo">');

      expect(html).toMatch(/<img src="https:\/\/cdn\.example\.com\/photo\.png" alt="photo" style="max-width:100%;height:auto">/);
    });

    it('adds the missing properties to a header/footer image without clobbering its existing style — not the sole-image case, kept alongside text', () => {
      const service = buildService();
      const html = service.wrap('<p>body</p>', {
        headerHtml: '<p>Some intro text</p><img src="https://cdn.example.com/banner.png" style="border:0;display:block;">',
        footerHtml: '<p>Some outro text</p><img src="https://cdn.example.com/footer.png" style="width:1px;height:1px;">',
      });

      expect(html).toContain('style="border:0;display:block;max-width:100%;height:auto"');
      // an image that already sets `height` keeps its own value — never overridden.
      expect(html).toContain('style="width:1px;height:1px;max-width:100%"');
    });

    it('never overrides an image that is already fully responsive (generic banner/pixel content) — not the sole-image case', () => {
      const service = buildService();
      const html = service.wrap('<p>body</p>', {
        headerHtml: '<p>Some intro text</p><img src="https://cdn.example.com/banner.png" style="width:100%;max-width:600px;height:auto;">',
      });

      expect(html).toContain('style="width:100%;max-width:600px;height:auto"');
    });

    it('keeps a side-by-side (imagesInline) image row inline — never forces display:block', () => {
      const service = buildService();
      const html = service.wrap('<p>body</p>', {
        footerHtml: '<img src="https://cdn.example.com/x.png"><img src="https://cdn.example.com/yt.png">',
      });

      expect(html).not.toContain('display:block');
    });
  });

  describe('wrap — sole header/footer image drops the row padding', () => {
    it('drops the header row padding and forces display:block for a single image (imagesInline <p> wrapper, as RichTextEditor produces)', () => {
      const service = buildService();
      const html = service.wrap('<p>body</p>', {
        headerHtml: '<p style="text-align: center"><img src="https://cdn.example.com/banner.png" alt="Banner" style="max-width:100%;height:auto"></p>',
      });

      expect(html).toContain('<td align="center" style="padding:0;">');
      expect(html).toContain(
        '<img src="https://cdn.example.com/banner.png" alt="Banner" style="max-width:100%;height:auto;display:block">',
      );
      // the <p> wrapper itself must be gone too — its default browser margin would otherwise still show a gap.
      expect(html).not.toContain('<p style="text-align: center">');
    });

    it('drops the footer row padding for a single linked image, keeping the <a href> wrapper intact (a clickable banner stays clickable)', () => {
      const service = buildService();
      const html = service.wrap('<p>body</p>', {
        footerHtml: '<p><a href="https://example.com"><img src="https://cdn.example.com/logo.png"></a></p>',
        footerBackgroundColor: '#111111',
      });

      expect(html).toContain('<td align="center" style="background:#111111;padding:0;">');
      expect(html).toContain('<a href="https://example.com"><img src="https://cdn.example.com/logo.png" style="max-width:100%;height:auto;display:block"></a>');
      // the <p> wrapper is gone (no default browser margin left to show a gap) — only the intentional <a href> markup remains.
      expect(html).toMatch(/<td align="center" style="background:#111111;padding:0;">\s*<a href="https:\/\/example\.com">/);
    });

    it('keeps the normal padding when the header has more than just the one image', () => {
      const service = buildService();
      const html = service.wrap('<p>body</p>', {
        headerHtml: '<p><img src="https://cdn.example.com/banner.png"></p><p>Also some text</p>',
      });

      expect(html).toContain('<td align="center" style="padding:0 0 24px 0;">');
    });

    it('keeps the normal padding for a row with more than one image', () => {
      const service = buildService();
      const html = service.wrap('<p>body</p>', {
        footerHtml: '<img src="https://cdn.example.com/a.png"><img src="https://cdn.example.com/b.png">',
      });

      expect(html).toContain('padding:28px 24px;');
    });

    it('applies the same padding drop when reapplyChrome() regenerates the row on its own (bypassing wrap())', () => {
      const service = buildService();
      const frozen = service.wrap('<p>body</p>', { headerHtml: '<p>Some intro text</p><img src="https://cdn.example.com/old.png">' });

      const updated = service.reapplyChrome(frozen, {
        headerHtml: '<p><img src="https://cdn.example.com/new-banner.png"></p>',
      });

      expect(updated).toContain('<td align="center" style="padding:0;">');
      expect(updated).toContain('display:block');
    });
  });
});
