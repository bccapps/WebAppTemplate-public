/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import { Injectable } from '@nestjs/common';
import { BrandIdentity, BrandService, SocialLink } from './BrandService';
import { LocaleService } from './LocaleService';

export interface EmailLayoutFooterLink {
  label: string;
  url: string;
}

export interface EmailLayoutOptions {
  /** Shown by most clients next to the subject; keep it under ~90 characters. */
  preheader?: string;
  /** Rendered as the last footer link. May be a `{{placeholder}}` resolved per recipient. */
  unsubscribeUrl?: string;
  unsubscribeLabel?: string;
  /** Legal / GDPR links — typically mentions légales, confidentialité, CGU. */
  footerLinks?: EmailLayoutFooterLink[];
  /** Appended verbatim just before `</body>` — used for the tracking pixel. */
  trailingHtml?: string;
  /**
   * Overrides the header row's inner content with admin-authored HTML (a
   * per-topic template — see CommunicationTopicEntity.templateHeader /
   * CommunicationRenderService). Empty/undefined falls back to the generic
   * brand header built from `renderDefaultHeaderContent()`.
   */
  headerHtml?: string;
  /**
   * Overrides the footer row's inner content with admin-authored HTML (a
   * per-topic template). Must include its own unsubscribe link if needed —
   * `unsubscribeUrl`/`unsubscribeLabel`/`footerLinks` are only consulted for
   * the generic fallback (`renderDefaultFooterContent()`), never merged into
   * a custom footer. Empty/undefined falls back to the generic footer.
   */
  footerHtml?: string;
  /** Background color (`#RRGGBB`) of the header row. Empty/undefined keeps the generic (transparent) background. */
  headerBackgroundColor?: string;
  /** Background color (`#RRGGBB`) of the footer row. Empty/undefined keeps `DEFAULT_FOOTER_BACKGROUND`. */
  footerBackgroundColor?: string;
}

export interface ArticleCardData {
  title: string;
  excerpt: string;
  url: string;
  imageUrl?: string;
  meta?: string;
}

/** Everything below 600px is the safe width for the desktop Outlook rendering engine. */
const CONTENT_WIDTH = 600;

const PAGE_BACKGROUND = '#f2f2f2';
const CARD_BACKGROUND = '#ede6d6';
/** Exported so a per-topic template's color picker can default to the same shade the generic header uses. */
export const DEFAULT_HEADER_BACKGROUND = '#17140f';
/** Exported so a per-topic template's color picker can default to the same shade the generic footer uses. */
export const DEFAULT_FOOTER_BACKGROUND = '#17140f';
const FOOTER_BACKGROUND = DEFAULT_FOOTER_BACKGROUND;
const TEXT_COLOR = '#2b2b2b';
const MUTED_COLOR = '#6b6b6b';
const FOOTER_TEXT_COLOR = '#b8b8b8';

const FONT_STACK = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/**
 * Bound the header/footer rows inside `wrap()`'s output so `reapplyChrome()`
 * can swap them back out later, on an already-frozen render, without
 * touching anything else. Plain HTML comments — ignored by every mail
 * client, including Outlook (which only treats `<!--[if ...]>` specially).
 */
const HEADER_MARKER_START = '<!--email-header-start-->';
const HEADER_MARKER_END = '<!--email-header-end-->';
const FOOTER_MARKER_START = '<!--email-footer-start-->';
const FOOTER_MARKER_END = '<!--email-footer-end-->';

/**
 * Builds the HTML shell every outbound e-mail shares: brand header, cream
 * content card, dark footer with social channels, legal links and the
 * unsubscribe link.
 *
 * Deliberately table-based with inline styles. Mail clients are not browsers:
 * Outlook's engine ignores flexbox and grid, Gmail strips `<style>` blocks and
 * inline SVG, and several clients drop external stylesheets entirely. Anything
 * fancier renders as an unstyled column of text in a meaningful share of
 * inboxes.
 *
 * Social channels render as `<img>` tags pointing at
 * `<siteUrl>/images/social/<key>.png` — raster files are the only icon form
 * every client renders, which is why the consuming app generates them at build
 * time (`npm run icons:social`). Each carries its channel name as `alt`, so an
 * app that ships no icon set degrades to a readable text link rather than a
 * broken image.
 */
@Injectable()
export class EmailLayoutService {
  constructor(
    private readonly brandService: BrandService,
    private readonly localeService: LocaleService,
  ) {}

  /**
   * Legal/GDPR footer links (mentions légales, confidentialité, CGU), reused
   * verbatim by the real per-recipient render (CommunicationRenderService)
   * and by the per-topic template default-content seed
   * (CommunicationTopicService) — single source of truth for wording+paths.
   */
  async buildFooterLinks(lang: string): Promise<EmailLayoutFooterLink[]> {
    const entries: [string, string][] = [
      ['common.app.footer.legal', 'legal-mentions'],
      ['common.app.footer.confidentiality', 'confidentiality'],
      ['common.app.footer.usage', 'usage-conditions'],
    ];
    const links = await Promise.all(
      entries.map(async ([key, path]) => ({
        label: await this.localeService.translate(key, lang),
        url: this.brandService.absoluteUrl(path),
      })),
    );
    return links.filter((link) => Boolean(link.url));
  }

  /** Wraps already-rendered body HTML in the brand shell. */
  wrap(bodyHtml: string, options: EmailLayoutOptions = {}): string {
    const brand = this.brandService.getIdentity();
    const preheader = options.preheader
      ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(options.preheader)}</div>`
      : '';

    return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light" />
<title>${escapeHtml(brand.siteName || '')}</title>
</head>
<body style="margin:0;padding:0;background:${PAGE_BACKGROUND};">
${preheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAGE_BACKGROUND};">
  <tr>
    <td align="center" style="padding:32px 12px;">
      <table role="presentation" width="${CONTENT_WIDTH}" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:${CONTENT_WIDTH}px;">
        ${this.renderHeaderRow(options)}
        <tr>
          <td style="background:${CARD_BACKGROUND};padding:32px;font-family:${FONT_STACK};font-size:15px;line-height:1.6;color:${TEXT_COLOR};">
${ensureResponsiveImages(bodyHtml)}
          </td>
        </tr>
        ${this.renderFooterRow(options)}
      </table>
    </td>
  </tr>
</table>
${options.trailingHtml ?? ''}
</body>
</html>`;
  }

  /**
   * Header row: `headerHtml` (a per-topic template) verbatim, or the generic
   * brand header. When that content is nothing but a single image (a full-
   * width banner, typically — see `extractSoleImage()`), the row drops its
   * own padding entirely so the image sits flush against the card below it,
   * instead of showing a band of `headerBackgroundColor` around it.
   */
  private renderHeaderRow(options: EmailLayoutOptions): string {
    const rawInner = options.headerHtml || this.renderDefaultHeaderContent();
    const soleImage = extractSoleImage(rawInner);
    const inner = ensureResponsiveImages(soleImage ?? rawInner, { block: Boolean(soleImage) });
    if (!inner) return `${HEADER_MARKER_START}${HEADER_MARKER_END}`;
    const background = options.headerBackgroundColor ? `background:${escapeAttr(options.headerBackgroundColor)};` : '';
    const padding = soleImage ? 'padding:0;' : 'padding:0 0 24px 0;';
    return `${HEADER_MARKER_START}<tr>
          <td align="center" style="${background}${padding}">
            ${inner}
          </td>
        </tr>${HEADER_MARKER_END}`;
  }

  /**
   * Generic header content. Prefers a full-width brand banner
   * (`common_brand_headerBannerUrl`) when configured; falls back to a logo
   * next to the wordmark, mirroring the app's top bar, when it isn't — an app
   * with no banner asset of its own still gets a sensible header instead of
   * nothing. Public so a per-topic template can be seeded from the exact
   * same markup it is meant to replace — see CommunicationTopicService.
   */
  renderDefaultHeaderContent(): string {
    const brand = this.brandService.getIdentity();
    const homeUrl = brand.siteUrl;

    const inner = brand.headerBannerUrl
      ? `<img src="${escapeAttr(brand.headerBannerUrl)}" width="${CONTENT_WIDTH}" alt="${escapeAttr(brand.siteName)}" style="display:block;border:0;width:100%;max-width:${CONTENT_WIDTH}px;height:auto;" />`
      : this.renderDefaultHeaderLogoWordmark(brand);

    if (!inner) return '';

    return homeUrl ? `<a href="${escapeAttr(homeUrl)}" style="text-decoration:none;">${inner}</a>` : inner;
  }

  /** Logo + wordmark composition — the header's fallback when no `headerBannerUrl` is configured. */
  private renderDefaultHeaderLogoWordmark(brand: BrandIdentity): string {
    const logo = brand.logoUrl
      ? `<img src="${escapeAttr(brand.logoUrl)}" width="40" height="40" alt="" style="display:block;border:0;width:40px;height:40px;" />`
      : '';
    const wordmark = brand.siteName
      ? `<span style="font-family:${FONT_STACK};font-size:22px;font-weight:600;letter-spacing:-0.02em;color:${TEXT_COLOR};">${escapeHtml(brand.siteName)}</span>`
      : '';

    if (!logo && !wordmark) return '';

    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      ${logo ? `<td style="padding-right:12px;">${logo}</td>` : ''}
      ${wordmark ? `<td style="vertical-align:middle;">${wordmark}</td>` : ''}
    </tr></table>`;
  }

  /**
   * Footer row: `footerHtml` (a per-topic template) verbatim, or the generic
   * brand footer. Same padding-drop as `renderHeaderRow()` when the content
   * is nothing but a single image — see `extractSoleImage()`.
   */
  private renderFooterRow(options: EmailLayoutOptions): string {
    const rawInner = options.footerHtml || this.renderDefaultFooterContent(options);
    const soleImage = extractSoleImage(rawInner);
    const inner = ensureResponsiveImages(soleImage ?? rawInner, { block: Boolean(soleImage) });
    if (!inner) return `${FOOTER_MARKER_START}${FOOTER_MARKER_END}`;
    const background = escapeAttr(options.footerBackgroundColor || FOOTER_BACKGROUND);
    const padding = soleImage ? 'padding:0;' : 'padding:28px 24px;';
    return `${FOOTER_MARKER_START}<tr>
          <td align="center" style="background:${background};${padding}">
            ${inner}
          </td>
        </tr>${FOOTER_MARKER_END}`;
  }

  /**
   * Swaps only the header/footer chrome inside an already-wrapped, frozen
   * email HTML — used to propagate an edited topic template onto
   * communications that were already prepared (see
   * `CommunicationRenderService.reapplyTopicChrome()`), without re-evaluating
   * the frozen body in between. Returns null when the markers are missing —
   * a communication frozen before this feature shipped has nothing to swap,
   * and the caller leaves it untouched.
   */
  reapplyChrome(html: string, options: EmailLayoutOptions): string | null {
    const withHeader = replaceBetweenMarkers(html, HEADER_MARKER_START, HEADER_MARKER_END, this.renderHeaderRow(options));
    if (withHeader === null) return null;
    return replaceBetweenMarkers(withHeader, FOOTER_MARKER_START, FOOTER_MARKER_END, this.renderFooterRow(options));
  }

  /**
   * Generic footer content: social channels, legal line, postal address and
   * link row (including the unsubscribe link, appended last). Public so a
   * per-topic template can be seeded from the exact same markup — the
   * unsubscribe link is then baked into the seed as a literal HTML `href`
   * (token placeholders survive rich-text editing since they live in an
   * attribute, never in an HTML comment).
   */
  renderDefaultFooterContent(options: EmailLayoutOptions): string {
    const brand = this.brandService.getIdentity();
    const socials = this.renderSocialRow(brand.socials);

    const links: EmailLayoutFooterLink[] = [...(options.footerLinks ?? [])];
    if (options.unsubscribeUrl) {
      links.push({ label: options.unsubscribeLabel || 'Se désabonner', url: options.unsubscribeUrl });
    }

    // Color lives on an inner <span>, not the outer <div>/<a>, because this
    // markup doubles as the per-topic template's editable seed content (see
    // the class doc above): TipTap's TextStyle/Color marks only recognize
    // `style="color:…"` on a <span> (and the Link mark's attribute schema
    // doesn't capture `style` at all), so a color set directly on a <div> or
    // <a> is silently dropped the instant this HTML is loaded into the
    // rich-text editor — and never comes back on save.
    const linkRow = links.length
      ? `<div style="margin-top:10px;font-family:${FONT_STACK};font-size:12px;">
              ${links
                .map(
                  (link) =>
                    `<a href="${escapeAttr(link.url)}" style="text-decoration:underline;"><span style="color:${FOOTER_TEXT_COLOR};">${escapeHtml(link.label)}</span></a>`,
                )
                .join(' <span style="opacity:0.5;">/</span> ')}
            </div>`
      : '';

    const legal = brand.legalLine
      ? `<div style="margin-top:14px;font-family:${FONT_STACK};font-size:12px;font-weight:600;"><span style="color:${FOOTER_TEXT_COLOR};">${escapeHtml(brand.legalLine)}</span></div>`
      : '';
    const address = brand.postalAddress
      ? `<div style="margin-top:4px;font-family:${FONT_STACK};font-size:12px;"><span style="color:${FOOTER_TEXT_COLOR};">${escapeHtml(brand.postalAddress)}</span></div>`
      : '';

    if (!socials && !linkRow && !legal && !address) return '';

    return `${socials}
            ${legal}
            ${address}
            ${linkRow}`;
  }

  /**
   * A `<table>` row of cells, not inline `<a><img>`s in a paragraph, would be
   * the more typical email-HTML pattern — deliberately avoided here because
   * this markup doubles as the per-topic template's editable seed content
   * (`renderDefaultFooterContent` → `CommunicationTopicService`), and the
   * rich-text editor (TipTap, no table extension loaded) has no schema node
   * for `<table>`/`<tr>`/`<td>`: loading one back in silently drops the
   * wrapper and disperses the cells, which is exactly the "images are no
   * longer side by side" bug this replaced. A plain centered paragraph of
   * inline images round-trips losslessly instead, and is a well-supported,
   * simpler pattern for a short icon row.
   */
  private renderSocialRow(socials: SocialLink[]): string {
    if (!socials.length) return '';
    const iconBase = this.brandService.absoluteUrl('images/social');

    const items = socials
      .map((social) => {
        // Rendered at 20px from a 40px source so it stays sharp on retina.
        // Without a site URL there is nothing to point at, so the label carries
        // the link on its own.
        const content = iconBase
          ? `<img src="${escapeAttr(`${iconBase}/${social.key}.png`)}" width="20" height="20" alt="${escapeAttr(social.label)}" style="display:inline-block;vertical-align:middle;border:0;width:20px;height:20px;" />`
          : escapeHtml(social.label);
        return `<a href="${escapeAttr(social.url)}" style="color:${FOOTER_TEXT_COLOR};text-decoration:none;">${content}</a>`;
      })
      // A plain space would collapse in HTML — `&nbsp;` either side keeps a
      // real, visible gap that also survives being typed further apart (or
      // removed) once this becomes editable rich-text content.
      .join(' &nbsp; ');

    return `<p style="margin:0;text-align:center;font-family:${FONT_STACK};font-size:13px;">${items}</p>`;
  }

  /** Primary call-to-action, styled like the dark button on the reference layout. */
  renderButton(label: string, url: string): string {
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:24px auto;"><tr>
      <td align="center" style="background:#111111;">
        <a href="${escapeAttr(url)}" style="display:inline-block;padding:14px 28px;font-family:${FONT_STACK};font-size:15px;color:#ffffff;text-decoration:none;">${escapeHtml(label)}</a>
      </td>
    </tr></table>`;
  }

  /**
   * One article block: optional thumbnail, title, excerpt and a permalink.
   * The thumbnail sits in its own table cell rather than a float — floats are
   * unreliable in Outlook, and a two-cell table degrades to stacked blocks on
   * narrow screens without any media query.
   */
  renderArticleCard(article: ArticleCardData, accentColor: string): string {
    const thumbnail = article.imageUrl
      ? `<td width="120" style="padding-right:16px;vertical-align:top;">
          <a href="${escapeAttr(article.url)}"><img src="${escapeAttr(article.imageUrl)}" width="120" alt="" style="display:block;border:0;width:120px;max-width:120px;height:auto;border-radius:4px;" /></a>
        </td>`
      : '';

    const meta = article.meta
      ? `<div style="margin:0 0 6px 0;font-family:${FONT_STACK};font-size:12px;text-transform:uppercase;letter-spacing:0.08em;color:${escapeAttr(accentColor)};">${escapeHtml(article.meta)}</div>`
      : '';

    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px 0;">
      <tr>
        ${thumbnail}
        <td style="vertical-align:top;">
          ${meta}
          <a href="${escapeAttr(article.url)}" style="font-family:${FONT_STACK};font-size:17px;font-weight:600;line-height:1.35;color:${TEXT_COLOR};text-decoration:none;">${escapeHtml(article.title)}</a>
          <div style="margin:8px 0 0 0;font-family:${FONT_STACK};font-size:14px;line-height:1.6;color:${MUTED_COLOR};">${escapeHtml(article.excerpt)}</div>
        </td>
      </tr>
    </table>`;
  }
}

/**
 * Merges `max-width:100%;height:auto` into every `<img>` tag's `style` that
 * doesn't already set those properties, so a header/footer/body image (an
 * admin-authored, `RichTextEditor`-inserted one especially — its own
 * `setImage()` call sets only `src`/`alt`, no sizing at all, see
 * `RichTextEditor.tsx`'s `LinkableImage`) can never force the surrounding
 * (600px-max, otherwise-responsive) table wider than the viewport it's shown
 * in — a real mobile mail client, or the admin preview's own mobile toggle.
 * Existing style properties are preserved (`Map` keyed by property name,
 * only missing keys are added) — including a pixel's own `width:1px;
 * height:1px` and the generic banner's own already-responsive sizing, both
 * left untouched. `display` is deliberately never added: a topic's
 * header/footer allows `imagesInline`-mode side-by-side images (e.g. a row
 * of social icons), which forcing `display:block` here would stack onto
 * separate lines. Applied at each of the three points admin-authored HTML
 * enters the shell — `wrap()`'s `bodyHtml` param, and `renderHeaderRow()`/
 * `renderFooterRow()`'s `headerHtml`/`footerHtml` (also reached by
 * `reapplyChrome()`, which regenerates only those two rows, bypassing
 * `wrap()` entirely) — so it retroactively fixes any image saved before this
 * existed too, without needing to be re-edited.
 */
function ensureResponsiveImages(html: string, options: { block?: boolean } = {}): string {
  return html.replace(/<img\b([^>]*)\/?>/gi, (match, attrs: string) => {
    const styleMatch = attrs.match(/\sstyle\s*=\s*"([^"]*)"/i);
    const properties = new Map<string, string>();
    (styleMatch?.[1] ?? '').split(';').forEach((declaration) => {
      const separatorIndex = declaration.indexOf(':');
      if (separatorIndex === -1) return;
      const property = declaration.slice(0, separatorIndex).trim().toLowerCase();
      const value = declaration.slice(separatorIndex + 1).trim();
      if (property && value) properties.set(property, value);
    });
    if (!properties.has('max-width')) properties.set('max-width', '100%');
    if (!properties.has('height')) properties.set('height', 'auto');
    // Only set for a lone header/footer image (see `extractSoleImage()`):
    // an inline/inline-block `<img>` carries a few pixels of baseline gap
    // below it, which would otherwise show as a sliver of the row's own
    // background even with the surrounding padding removed.
    if (options.block && !properties.has('display')) properties.set('display', 'block');
    const nextStyle = Array.from(properties.entries())
      .map(([property, value]) => `${property}:${value}`)
      .join(';');
    const nextAttrs = styleMatch
      ? attrs.replace(/\sstyle\s*=\s*"[^"]*"/i, ` style="${nextStyle}"`)
      : `${attrs} style="${nextStyle}"`;
    return match.trimEnd().endsWith('/>') ? `<img${nextAttrs}/>` : `<img${nextAttrs}>`;
  });
}

/**
 * Returns just the image — bare, or still wrapped in its `<a href>` when
 * linked — when `html`'s only meaningful content is a single image:
 * typically `RichTextEditor`'s output for a header/footer zone the admin
 * filled with nothing but one banner (in `imagesInline` mode, wrapped in a
 * centering `<p>`, optionally an `<a href>` for a linked image). Lets the
 * caller drop the row's own padding and render just the image, edge to edge.
 * Only the `<p>` is stripped: it carries its own default browser margin,
 * which would otherwise still show a band of background color around the
 * image even with the row's padding removed — `<a href>` is real, functional
 * markup (a clickable banner) and is always kept intact. Returns null for
 * anything else (no image, more than one, or an image alongside other
 * content), leaving the row's normal padding and wrapper markup untouched.
 */
function extractSoleImage(html: string): string | null {
  // Only <p> is stripped for the check — it never carries meaning worth
  // keeping here, but always its own default browser margin, which is
  // exactly the gap this function exists to eliminate. <a href> is a real,
  // functional wrapper (a clickable banner) and is kept — see below.
  const withoutParagraphs = html
    .replace(/<\/?p[^>]*>/gi, '')
    .replace(/&nbsp;/gi, ' ')
    .trim();
  const bareImage = withoutParagraphs.match(/^(<img\b[^>]*\/?>)$/i);
  if (bareImage) return bareImage[1];
  const linkedImage = withoutParagraphs.match(/^(<a\b[^>]*>\s*<img\b[^>]*\/?>\s*<\/a>)$/i);
  return linkedImage ? linkedImage[1] : null;
}

/** Replaces the content between a marker pair with `replacement`, or null when the markers aren't found. */
function replaceBetweenMarkers(html: string, start: string, end: string, replacement: string): string | null {
  const startIndex = html.indexOf(start);
  const endIndex = html.indexOf(end);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) return null;
  return html.slice(0, startIndex) + replacement + html.slice(endIndex + end.length);
}

export function escapeHtml(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function escapeAttr(value: string): string {
  return escapeHtml(value);
}

/** Strips tags then keeps the first `words` words, appending an ellipsis when cut. */
export function truncateWords(html: string, words: number): string {
  const text = String(html ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  const parts = text.split(' ');
  if (parts.length <= words) return text;
  return `${parts.slice(0, words).join(' ')}…`;
}
