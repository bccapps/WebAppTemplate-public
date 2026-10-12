/**
 * VXFramework
 *
 * Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
 * SPDX-License-Identifier: MIT
 *
 * Licensed under the MIT License. See LICENSE in the project root.
 */

export type ResizeImageOptions = {
  /** Largest edge, in pixels, the resized image is allowed to have. Default 512. */
  maxSize?: number;
  /** 0..1 lossy-encoding quality. Default 0.85. */
  quality?: number;
};

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = src;
  });
}

function fitWithin(width: number, height: number, maxSize: number): { width: number; height: number } {
  if (width <= maxSize && height <= maxSize) {
    return { width, height };
  }
  const ratio = width > height ? maxSize / width : maxSize / height;
  return { width: Math.round(width * ratio), height: Math.round(height * ratio) };
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), mimeType, quality));
}

/**
 * Resizes an image file client-side (never uploads the original, however large) so it is
 * reasonable to serve as a site avatar. Prefers WebP; falls back to JPEG when the browser
 * cannot encode WebP (canvas.toBlob returns null in that case).
 */
export async function resizeImageToBlob(file: File, options: ResizeImageOptions = {}): Promise<Blob> {
  const { maxSize = 512, quality = 0.85 } = options;
  const dataUrl = await readFileAsDataUrl(file);
  const img = await loadImage(dataUrl);
  const { width, height } = fitWithin(img.naturalWidth, img.naturalHeight, maxSize);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas 2D context unavailable');
  }
  ctx.drawImage(img, 0, 0, width, height);

  const webp = await canvasToBlob(canvas, 'image/webp', quality);
  if (webp) return webp;
  const jpeg = await canvasToBlob(canvas, 'image/jpeg', quality);
  if (jpeg) return jpeg;
  throw new Error('Failed to encode resized image');
}

export default resizeImageToBlob;
