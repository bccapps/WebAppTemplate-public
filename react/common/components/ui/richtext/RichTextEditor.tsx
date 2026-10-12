/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

import React, { useEffect, useReducer, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { mergeAttributes, type DOMOutputSpecArray } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyle } from '@tiptap/extension-text-style';
import Color from '@tiptap/extension-color';
import { Alert, Box, Divider, IconButton, MenuItem, Select, type SelectChangeEvent, Stack, Tooltip } from '@mui/material';
import FormatBoldIcon from '@mui/icons-material/FormatBold';
import FormatItalicIcon from '@mui/icons-material/FormatItalic';
import FormatUnderlinedIcon from '@mui/icons-material/FormatUnderlined';
import StrikethroughSIcon from '@mui/icons-material/StrikethroughS';
import FormatListBulletedIcon from '@mui/icons-material/FormatListBulleted';
import FormatListNumberedIcon from '@mui/icons-material/FormatListNumbered';
import FormatQuoteIcon from '@mui/icons-material/FormatQuote';
import FormatAlignLeftIcon from '@mui/icons-material/FormatAlignLeft';
import FormatAlignCenterIcon from '@mui/icons-material/FormatAlignCenter';
import FormatAlignRightIcon from '@mui/icons-material/FormatAlignRight';
import FormatColorTextIcon from '@mui/icons-material/FormatColorText';
import FormatColorFillIcon from '@mui/icons-material/FormatColorFill';
import FormatColorResetIcon from '@mui/icons-material/FormatColorReset';
import ImageIcon from '@mui/icons-material/Image';
import OndemandVideoIcon from '@mui/icons-material/OndemandVideo';
import YouTubeIcon from '@mui/icons-material/YouTube';
import LinkIcon from '@mui/icons-material/Link';
import { I18nLabel } from '../label/I18nLabel';
import { i18n } from '../../../core/i18n/I18n';

interface RichTextEditorProps {
  value: string;
  onChange: (html: string) => void;
  /**
   * Uploads a dropped/inserted image and resolves to its URL. Omit to fall
   * back to embedding the image as a base64 data URL (fine for one-off admin
   * content, but bloats the stored HTML — pass this whenever the caller has
   * somewhere real to store the file, e.g. CMS article inline images).
   */
  onUploadImage?: (file: File) => Promise<string>;
  minHeight?: number;
  /**
   * Inserts images as inline content (sitting on the same line as text and
   * other images, wrappable, alignable as part of that line's `TextAlign`)
   * instead of the default standalone block. Off by default to preserve the
   * existing behaviour for a full-width content image (CMS articles, tier
   * descriptions) — turn on for a zone expected to hold small side-by-side
   * images, e.g. a row of social icons in an e-mail header/footer template.
   */
  imagesInline?: boolean;
  /**
   * Background color (`#RRGGBB`) of the editor's own zone — e.g. a
   * communication template's header/footer row background, distinct from
   * text color (set per-run inside the content). Passing either this or
   * `onBackgroundColorChange` switches the canvas to explicit black text /
   * blue links instead of inheriting the app's own theme, so the editor
   * honestly shows what unstyled content actually looks like once rendered
   * outside the app (a real e-mail, a public page) instead of borrowing a
   * color that was never really set. Pass both to also render a toolbar
   * swatch + "no background" reset (an editable per-instance zone, e.g. a
   * topic's header/footer row); pass `backgroundColor` alone for a fixed,
   * non-editable zone whose real background is a global constant (e.g. the
   * body card's background, the same for every communication) — no picker
   * renders, since there is nothing to persist per-instance. Omitted
   * entirely by every other caller (CMS articles, tier descriptions), which
   * keeps today's exact appearance.
   */
  backgroundColor?: string | null;
  onBackgroundColorChange?: (hex: string) => void;
}

const toolbarSx = {
  border: '1px solid',
  borderColor: 'divider',
  borderRadius: 1,
  p: 0.5,
  mb: 1,
  flexWrap: 'wrap',
  alignItems: 'center'
};

type BlockType = 'paragraph' | 'h1' | 'h2' | 'h3' | 'h4';

const blockTypeOptions: BlockType[] = ['h1', 'h2', 'h3', 'h4', 'paragraph'];

const blockTypeLabelId: Record<BlockType, string> = {
  h1: 'common.richtext.editor.heading1',
  h2: 'common.richtext.editor.heading2',
  h3: 'common.richtext.editor.heading3',
  h4: 'common.richtext.editor.heading4',
  paragraph: 'common.richtext.editor.paragraph'
};

/** Mirrors StarterKit's default heading scale so the dropdown previews what each option actually looks like, instead of every entry rendering identically. */
const blockTypeStyle: Record<BlockType, { fontSize: string; fontWeight: number }> = {
  h1: { fontSize: '1.6rem', fontWeight: 700 },
  h2: { fontSize: '1.35rem', fontWeight: 700 },
  h3: { fontSize: '1.15rem', fontWeight: 600 },
  h4: { fontSize: '1rem', fontWeight: 600 },
  paragraph: { fontSize: '0.85rem', fontWeight: 400 }
};

/**
 * `href` can't reuse the `Link` mark: marks apply to a text selection range,
 * and an image is an atom node with no such range. Wrapping the `<img>` in an
 * `<a href>` in `renderHTML` is what actually makes it clickable in a
 * received e-mail (a mark could not produce that wrapping).
 *
 * Alignment does NOT need an attribute of its own: with `inline: true` (see
 * `imagesInline` prop) the image is inline content of its paragraph like any
 * word of text, so the existing `TextAlign` extension centers/aligns it (and
 * any neighbours on the same line, e.g. a row of social icons) exactly like
 * it already does for text — `updateAttributes`/`setTextAlign` walk up to the
 * nearest matching ancestor (the paragraph) regardless of whether the current
 * selection is a text range or a NodeSelection on the image itself.
 */
const LinkableImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      href: {
        default: null,
        parseHTML: (element: HTMLElement) => element.closest('a')?.getAttribute('href') ?? null,
        renderHTML: () => ({}),
      },
    };
  },
  // `HTMLAttributes` here already excludes `href` (its own `renderHTML` above
  // returns `{}` on purpose, so it never leaks onto the `<img>` tag itself) —
  // read the real value straight off `node.attrs` instead.
  //
  // `setImage({ src, alt })` (see `insertImageFile` below) sets no sizing at
  // all — an uploaded image would otherwise export at its full natural pixel
  // size, overflowing a narrow viewport in an e-mail (the editor's own `'&
  // img'` CSS rule below only affects this component's on-screen canvas, not
  // the HTML `getHTML()` actually exports). The base style is listed FIRST so
  // any future per-image explicit width/style wins on a per-property basis —
  // `mergeAttributes` merges `style` property-by-property, not as one string.
  renderHTML({ node, HTMLAttributes }) {
    const img: DOMOutputSpecArray = [
      'img',
      mergeAttributes({ style: 'max-width:100%;height:auto;' }, this.options.HTMLAttributes, HTMLAttributes),
    ];
    return node.attrs.href ? ['a', { href: node.attrs.href, style: 'text-decoration:none;' }, img] : img;
  },
});

const editorSx = (minHeight: number, isZoneEditor: boolean, zoneBackground?: string | null) => ({
  border: '1px solid',
  borderColor: 'divider',
  borderRadius: 1,
  p: 2,
  minHeight: `${minHeight}px`,
  maxHeight: '520px',
  overflowY: 'auto',
  fontSize: '0.95rem',
  lineHeight: 1.5,
  ...(isZoneEditor ? { backgroundColor: zoneBackground || undefined } : {}),
  '& .ProseMirror': {
    outline: 'none',
    ...(isZoneEditor ? { color: '#000000' } : {})
  },
  ...(isZoneEditor ? { '& .ProseMirror a': { color: '#0645ad' } } : {}),
  '& img': { maxWidth: '100%', height: 'auto' },
  // ProseMirror adds this class to a node's DOM element while it holds a
  // NodeSelection (e.g. a clicked image) — with no rule for it, selecting an
  // image gave zero visual feedback, which read as "nothing got selected".
  // A linked image's outer DOM node is the wrapping <a> (see LinkableImage's
  // renderHTML), so ProseMirror puts the selection class there instead of on
  // the <img> — both selectors are needed depending on whether the image is
  // currently linked.
  '& img.ProseMirror-selectednode, & a.ProseMirror-selectednode': {
    outline: '2px solid #1976d2',
    outlineOffset: '2px',
  },
  '& video': { maxWidth: '100%' }
});

export const RichTextEditor: React.FC<RichTextEditorProps> = ({
  value,
  onChange,
  onUploadImage,
  minHeight = 260,
  imagesInline = false,
  backgroundColor,
  onBackgroundColorChange
}) => {
  const editor = useEditor({
    // allowBase64: without it @tiptap/extension-image parses `img[src]:not([src^="data:"])`,
    // so base64 images (inserted when no upload handler is available, or before
    // an article has an id and no server URL yet) are silently dropped when the
    // saved content is re-loaded into the editor.
    extensions: [
      // StarterKit bundles `Link` with `openOnClick: true` by default, which
      // registers a ProseMirror plugin that intercepts a click on ANY <a> in
      // the editor (including LinkableImage's, unrelated to the Link mark)
      // and calls `window.open()` directly — before our own click handler
      // ever runs, and regardless of `preventDefault()`. Disabled here;
      // `handleEditorClick` below implements the actual Ctrl/Cmd-click-only
      // behavior uniformly for text and image links.
      StarterKit.configure({ link: { openOnClick: false } }),
      LinkableImage.configure({ allowBase64: true, inline: imagesInline }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      TextStyle,
      Color,
    ],
    content: value || '',
    onUpdate: ({ editor: instance }) => onChange(instance.getHTML())
  });

  useEffect(() => {
    if (editor && value !== editor.getHTML()) {
      editor.commands.setContent(value || '', { emitUpdate: false });
    }
  }, [value, editor]);

  const [imageUploadError, setImageUploadError] = useState<string | null>(null);

  const [, forceToolbarRefresh] = useReducer((tick: number) => tick + 1, 0);

  useEffect(() => {
    if (!editor) return;
    editor.on('selectionUpdate', forceToolbarRefresh);
    editor.on('transaction', forceToolbarRefresh);
    return () => {
      editor.off('selectionUpdate', forceToolbarRefresh);
      editor.off('transaction', forceToolbarRefresh);
    };
  }, [editor]);

  const currentBlockType: BlockType = blockTypeOptions.find((type) =>
    type === 'paragraph' ? editor?.isActive('paragraph') : editor?.isActive('heading', { level: Number(type[1]) })
  ) ?? 'paragraph';

  const setBlockType = (type: BlockType) => {
    if (!editor) return;
    if (type === 'paragraph') {
      editor.chain().focus().setParagraph().run();
      return;
    }
    editor
      .chain()
      .focus()
      .setHeading({ level: Number(type[1]) as 1 | 2 | 3 | 4 })
      .run();
  };

  // Applies to the paragraph/heading containing the current selection —
  // `updateAttributes` (which `setTextAlign` delegates to) matches any
  // ancestor of that type regardless of whether the selection is a text
  // range or a NodeSelection on an inline image, so this aligns an image
  // (and any text/other images sharing its line) exactly like it would a
  // line of plain text — no per-image attribute needed.
  const setAlign = (value: 'left' | 'center' | 'right') => {
    editor?.chain().focus().setTextAlign(value).run();
  };

  const isAlignActive = (value: 'left' | 'center' | 'right'): boolean => {
    return editor?.isActive({ textAlign: value }) ?? false;
  };

  // Linking an image goes through its own node attribute (see LinkableImage
  // above) instead of the Link mark, which can't apply to an atom node.
  const insertLink = () => {
    if (!editor || typeof window === 'undefined') return;
    if (editor.isActive('image')) {
      const previousHref = editor.getAttributes('image').href as string | undefined;
      const url = window.prompt(i18n.get('common.richtext.editor.promptLink'), previousHref ?? '');
      if (url === null) return;
      editor.chain().focus().updateAttributes('image', { href: url.trim() || null }).run();
      return;
    }
    const previousUrl = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt(i18n.get('common.richtext.editor.promptLink'), previousUrl ?? '');
    if (url === null) return;
    if (url.trim() === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url.trim() }).run();
  };

  const insertYoutube = () => {
    if (!editor || typeof window === 'undefined') return;
    const raw = window.prompt(i18n.get('common.richtext.editor.promptYoutube'));
    if (!raw) return;
    const embedUrl = normalizeYoutube(raw.trim());
    if (embedUrl) {
      editor
        .chain()
        .focus()
        .insertContent(
          `<div class="richtext-youtube-frame" style="margin-top:16px;"><iframe width="100%" height="315" src="${embedUrl}" frameborder="0" allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></div>`
        )
        .run();
    }
  };

  const insertImageFile = (file: File) => {
    if (!editor) return;
    if (onUploadImage) {
      setImageUploadError(null);
      onUploadImage(file)
        .then((url) => {
          editor.chain().focus().setImage({ src: url, alt: file.name }).run();
        })
        // `onUploadImage` rejects with the caller's HTTP error payload (shape varies by
        // service, e.g. HttpService's `{ message, code, statusCode }`) — surface its
        // `message` (the backend's actual reason: too large, unsupported type, etc.)
        // instead of a single generic string that hides why every failure happened.
        .catch((err: unknown) => {
          const detail =
            err && typeof err === 'object' && 'message' in err && typeof (err as { message?: unknown }).message === 'string'
              ? (err as { message: string }).message
              : undefined;
          setImageUploadError(detail || i18n.get('common.richtext.editor.imageUploadError'));
        });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result?.toString();
      if (result) {
        editor.chain().focus().setImage({ src: result, alt: file.name }).run();
      }
    };
    reader.readAsDataURL(file);
  };

  const insertImage = () => {
    if (!editor || typeof document === 'undefined') return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) insertImageFile(file);
    };
    input.click();
  };

  const handleEditorDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith('image/')) {
      insertImageFile(file);
    }
  };

  // A linked image (LinkableImage's <a href> wrapper) must stay a normal,
  // clickable-to-select editor element on a plain click — only a modifier
  // click follows the link, same convention as most desktop editors, and the
  // opposite of the browser's native "always navigate" behavior for an <a>.
  // A link (text or image) must stay a plain, click-to-edit/select editor
  // element and never navigate on an ordinary click — only a Ctrl/Cmd+click
  // opens it, left to the browser's own native modifier-click handling
  // (opens in a background tab, respects popup-blocker exemptions for a real
  // user gesture) rather than an imperative `window.open()`.
  const handleEditorClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as HTMLElement).closest('a');
    if (anchor && !(e.ctrlKey || e.metaKey)) {
      e.preventDefault();
    }
  };

  const insertVideo = () => {
    if (!editor || typeof document === 'undefined') return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result?.toString();
        if (result) {
          editor
            .chain()
            .focus()
            .insertContent(
              `<video controls style="width:100%;max-height:420px;"><source src="${result}" type="${file.type}" /></video>`
            )
            .run();
        }
      };
      reader.readAsDataURL(file);
    };
    input.click();
  };

  return (
    <Box>
      {/* Without this, clicking a toolbar button steals DOM focus from the
          editor on mousedown — for a NodeSelection (e.g. a selected image)
          this is enough for the browser to drop it before the button's
          onClick even runs, so every command below silently no-ops. */}
      <Stack direction="row" spacing={0.5} sx={toolbarSx} onMouseDown={(e) => e.preventDefault()}>
        <Tooltip title={<I18nLabel id="common.richtext.editor.bold" />}>
          <IconButton size="small" onClick={() => editor?.chain().focus().toggleBold().run()}>
            <FormatBoldIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title={<I18nLabel id="common.richtext.editor.italic" />}>
          <IconButton size="small" onClick={() => editor?.chain().focus().toggleItalic().run()}>
            <FormatItalicIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title={<I18nLabel id="common.richtext.editor.underline" />}>
          <IconButton size="small" onClick={() => editor?.chain().focus().toggleUnderline().run()}>
            <FormatUnderlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title={<I18nLabel id="common.richtext.editor.strike" />}>
          <IconButton size="small" onClick={() => editor?.chain().focus().toggleStrike().run()}>
            <StrikethroughSIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title={<I18nLabel id="common.richtext.editor.list" />}>
          <IconButton size="small" onClick={() => editor?.chain().focus().toggleBulletList().run()}>
            <FormatListBulletedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title={<I18nLabel id="common.richtext.editor.orderedList" />}>
          <IconButton size="small" onClick={() => editor?.chain().focus().toggleOrderedList().run()}>
            <FormatListNumberedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title={<I18nLabel id="common.richtext.editor.quote" />}>
          <IconButton size="small" onClick={() => editor?.chain().focus().toggleBlockquote().run()}>
            <FormatQuoteIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Divider orientation="vertical" flexItem sx={{ mx: 0.5 }} />
        <Tooltip title={<I18nLabel id="common.richtext.editor.alignLeft" />}>
          <IconButton size="small" color={isAlignActive('left') ? 'primary' : 'default'} onClick={() => setAlign('left')}>
            <FormatAlignLeftIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title={<I18nLabel id="common.richtext.editor.alignCenter" />}>
          <IconButton size="small" color={isAlignActive('center') ? 'primary' : 'default'} onClick={() => setAlign('center')}>
            <FormatAlignCenterIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title={<I18nLabel id="common.richtext.editor.alignRight" />}>
          <IconButton size="small" color={isAlignActive('right') ? 'primary' : 'default'} onClick={() => setAlign('right')}>
            <FormatAlignRightIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Divider orientation="vertical" flexItem sx={{ mx: 0.5 }} />
        <Tooltip title={<I18nLabel id="common.richtext.editor.textColor" />}>
          <IconButton size="small" component="label" sx={{ position: 'relative' }}>
            <FormatColorTextIcon fontSize="small" />
            <Box
              component="input"
              type="color"
              value={editor?.getAttributes('textStyle').color || '#000000'}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                editor?.chain().focus().setColor(e.target.value).run()
              }
              sx={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0, cursor: 'pointer' }}
            />
          </IconButton>
        </Tooltip>
        <Tooltip title={<I18nLabel id="common.richtext.editor.textColorClear" />}>
          <IconButton size="small" onClick={() => editor?.chain().focus().unsetColor().run()}>
            <FormatColorResetIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        {onBackgroundColorChange && (
          <>
            <Tooltip title={<I18nLabel id="common.richtext.editor.backgroundColor" />}>
              <IconButton size="small" component="label" sx={{ position: 'relative' }}>
                <FormatColorFillIcon fontSize="small" />
                <Box
                  component="input"
                  type="color"
                  value={backgroundColor || '#ffffff'}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => onBackgroundColorChange(e.target.value)}
                  sx={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0, cursor: 'pointer' }}
                />
              </IconButton>
            </Tooltip>
            {backgroundColor && (
              <Tooltip title={<I18nLabel id="common.richtext.editor.backgroundColorClear" />}>
                <IconButton size="small" onClick={() => onBackgroundColorChange('')}>
                  <FormatColorResetIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
          </>
        )}
        <Tooltip title={<I18nLabel id="common.richtext.editor.link" />}>
          <IconButton size="small" onClick={insertLink}>
            <LinkIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title={<I18nLabel id="common.richtext.editor.image" />}>
          <IconButton size="small" onClick={insertImage}>
            <ImageIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title={<I18nLabel id="common.richtext.editor.video" />}>
          <IconButton size="small" onClick={insertVideo}>
            <OndemandVideoIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title={<I18nLabel id="common.richtext.editor.youtube" />}>
          <IconButton size="small" onClick={insertYoutube}>
            <YouTubeIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Divider orientation="vertical" flexItem sx={{ mx: 0.5 }} />
        <Select
          size="small"
          variant="standard"
          disableUnderline
          value={currentBlockType}
          onChange={(e: SelectChangeEvent) => setBlockType(e.target.value as BlockType)}
          aria-label={i18n.get('common.richtext.editor.blockType')}
          sx={{ minWidth: 130, fontSize: '0.85rem' }}
        >
          {blockTypeOptions.map((type) => (
            <MenuItem key={type} value={type} sx={blockTypeStyle[type]}>
              <I18nLabel id={blockTypeLabelId[type]} />
            </MenuItem>
          ))}
        </Select>
      </Stack>
      {imageUploadError && (
        <Alert severity="warning" sx={{ mb: 1 }} onClose={() => setImageUploadError(null)}>
          {imageUploadError}
        </Alert>
      )}
      <Box
        sx={editorSx(minHeight, Boolean(onBackgroundColorChange) || backgroundColor != null, backgroundColor)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleEditorDrop}
        onClick={handleEditorClick}
      >
        <EditorContent editor={editor} />
      </Box>
    </Box>
  );
};

const normalizeYoutube = (url: string): string | null => {
  const prepared = url.startsWith('http') ? url : `https://${url}`;
  try {
    const parsed = new URL(prepared);
    if (parsed.hostname.includes('youtube.com')) {
      const videoId = parsed.searchParams.get('v');
      if (videoId) {
        return `https://www.youtube.com/embed/${videoId}`;
      }
    }
    if (parsed.hostname.includes('youtu.be')) {
      const segments = parsed.pathname.split('/');
      const videoId = segments[segments.length - 1];
      if (videoId) {
        return `https://www.youtube.com/embed/${videoId}`;
      }
    }
    return prepared;
  } catch (err) {
    return null;
  }
};
