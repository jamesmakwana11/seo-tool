import { useState } from 'react';
import clsx from 'clsx';
import { ImageOff } from 'lucide-react';

/** A small preview URL: Shopify's CDN resizes on request, so a thumbnail does not download the full-size image. */
export function thumbUrl(src: string, width = 160): string {
  try {
    const u = new URL(src);
    if (/(^|\.)cdn\.shopify\.com$/i.test(u.hostname) || u.pathname.startsWith('/cdn/shop/')) {
      u.searchParams.set('width', String(width));
      return u.toString();
    }
  } catch { /* not an absolute URL — shown as is */ }
  return src;
}

/**
 * Image preview loaded straight from the website (lazy, no referrer). When the browser cannot show it (removed image,
 * plain http, blocked host) a placeholder says so instead of a broken-image icon.
 */
export function ImageThumb({ src, alt = '', size = 48, className }: { src: string; alt?: string; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  const box = { width: size, height: size };
  if (failed || !/^https:\/\//i.test(src)) {
    return (
      <span style={box} className={clsx('inline-flex shrink-0 items-center justify-center rounded border border-line bg-canvas text-faint', className)} title="Preview not available (the image did not load in this browser)" data-testid="thumb-unavailable">
        <ImageOff className="h-4 w-4" aria-hidden />
      </span>
    );
  }
  return (
    <img
      src={thumbUrl(src, Math.max(80, size * 2))} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer"
      style={box} className={clsx('shrink-0 rounded border border-line bg-canvas object-contain', className)}
      onError={() => setFailed(true)} data-testid="thumb"
    />
  );
}
