'use client';

import React, { useMemo } from 'react';
import DOMPurify from 'dompurify';
import { FORBID_TAGS, FORBID_ATTRS } from '@/lib/html-sanitizer';
import './SvgBlock.css';

export interface SvgBlockProps {
  markup: string;
}

const SVG_SIZE_CAP = 10_000;

/**
 * Sanitize SVG markup using DOMPurify with a strict SVG profile.
 *
 * Stripped unconditionally:
 *   - <script> and all script content
 *   - All on* event handler attributes (onclick, onerror, onload, …)
 *   - <iframe>, <foreignObject> (allows arbitrary HTML embedding)
 *   - <use> elements with external href/xlink:href — already blocked by
 *     DOMPurify's SVG profile built-in check. Verified by
 *     `tests/unit/svg-block-sanitization.test.ts`; no explicit handling
 *     needed in our config.
 *   - javascript: URIs in any href/src (ALLOW_UNKNOWN_PROTOCOLS:false)
 *   - **External https:// and data: URIs in <image>/<a>/<use> href &
 *     xlink:href** via the per-call `afterSanitizeAttributes` hook below
 *     (Sprint 34 T8). DOMPurify's USE_PROFILES.svg + ALLOW_UNKNOWN_PROTOCOLS:false
 *     does NOT block known schemes like `https:` or `data:`, which is a
 *     tracking-pixel + latent XSS vector. The hook restricts href/xlink:href
 *     to in-document fragment refs (`#id`) only — preserves legitimate
 *     `<use xlink:href='#gradient1'>` within a single SVG and blocks every
 *     external or data: reference.
 *
 * **Hook isolation:** the hook is registered per-call and always removed
 * in a finally block so other DOMPurify consumers in the codebase (chat
 * renderer, etc.) are NOT affected. See the 'global hook contamination'
 * test in `tests/unit/svg-block-sanitization.test.ts` for regression coverage.
 *
 * DOMPurify FORCE_BODY is set to prevent SVG from being promoted to
 * document root. USE_PROFILES.svg restricts to SVG-safe elements only.
 */
export function sanitizeSvg(raw: string): string {
  if (typeof window === 'undefined') return '';

  // Scope-local hook — add before sanitize, remove in finally. Does NOT
  // leak into other DOMPurify consumers (chat renderer, etc.).
  const restrictHrefs = (node: Element) => {
    for (const attrName of ['href', 'xlink:href']) {
      const val = node.getAttribute(attrName);
      if (val && !val.startsWith('#')) {
        node.removeAttribute(attrName);
      }
    }
  };

  DOMPurify.addHook('afterSanitizeAttributes', restrictHrefs);
  try {
    return DOMPurify.sanitize(raw, {
      USE_PROFILES: { svg: true, svgFilters: true },
      FORCE_BODY: false,
      FORBID_TAGS,
      FORBID_ATTR: FORBID_ATTRS,
      ALLOW_UNKNOWN_PROTOCOLS: false,
      ADD_TAGS: ['use'],
    });
  } finally {
    // Always remove the hook even if sanitize throws — prevents global
    // contamination of unrelated DOMPurify.sanitize() calls elsewhere.
    DOMPurify.removeHook('afterSanitizeAttributes');
  }
}

export default function SvgBlock({ markup }: SvgBlockProps) {
  const sanitized = useMemo(() => {
    if (markup.length > SVG_SIZE_CAP) return null;
    const clean = sanitizeSvg(markup.trim());
    // Must contain an svg element after sanitization
    if (!clean.includes('<svg') && !clean.includes('<SVG')) return null;
    return clean;
  }, [markup]);

  if (markup.length > SVG_SIZE_CAP) {
    return (
      <div className="cb-svg cb-svg--oversized" role="alert">
        SvgBlock: spec exceeds 10KB limit.
      </div>
    );
  }

  if (!sanitized) {
    return (
      <div className="cb-svg cb-svg--error" role="alert">
        SvgBlock: invalid or empty SVG markup.
      </div>
    );
  }

  return (
    <div
      className="cb-svg"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: sanitized }}
      aria-label="SVG diagram"
    />
  );
}
