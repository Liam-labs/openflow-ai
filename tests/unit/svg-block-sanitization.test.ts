// @vitest-environment jsdom

/**
 * Sprint 34 T8 — security audit for SvgBlock's DOMPurify sanitize layer.
 *
 * Every payload in this file is a real XSS / data-exfiltration vector that
 * would execute or leak data if the sanitize layer missed it. RED-first:
 * each test pins the expected blocked shape, so a regression (e.g. someone
 * loosens the FORBID_TAGS list) surfaces immediately.
 *
 * Jack flagged test cases 6 and 8 as uncertain — external https fetches via
 * xlink:href / href. DOMPurify's USE_PROFILES.svg + ALLOW_UNKNOWN_PROTOCOLS:false
 * permits the https scheme through its default ALLOWED_URI_REGEXP, so we
 * need to verify behavior empirically and fix if we find a gap.
 */

import { describe, it, expect } from 'vitest';
// Import the real production sanitizeSvg — no config duplication that can drift.
import { sanitizeSvg } from '../../components/chat-blocks/SvgBlock';

const SVG_SIZE_CAP = 10_000;

function svgBlockRender(markup: string): string | null {
  if (markup.length > SVG_SIZE_CAP) return null;
  const clean = sanitizeSvg(markup.trim());
  if (!clean.includes('<svg') && !clean.includes('<SVG')) return null;
  return clean;
}

describe('SvgBlock sanitization — script + event handler injection', () => {
  it('strips <script> tags embedded inside an svg', () => {
    const payload = `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><circle cx="10" cy="10" r="5"/></svg>`;
    const out = svgBlockRender(payload);
    expect(out).not.toBeNull();
    expect(out!.toLowerCase()).not.toContain('<script');
    expect(out!).not.toContain('alert(1)');
    // Harmless content preserved
    expect(out!).toContain('circle');
  });

  it('strips onclick attribute from <svg>', () => {
    const payload = `<svg xmlns="http://www.w3.org/2000/svg" onclick="alert(1)"><circle cx="10" cy="10" r="5"/></svg>`;
    const out = svgBlockRender(payload);
    expect(out).not.toBeNull();
    expect(out!.toLowerCase()).not.toContain('onclick');
    expect(out!).not.toContain('alert(1)');
    expect(out!.toLowerCase()).toContain('<svg');
  });

  it('strips <iframe> embedded inside an svg', () => {
    const payload = `<svg xmlns="http://www.w3.org/2000/svg"><iframe src="https://evil.com/xss.html"/></svg>`;
    const out = svgBlockRender(payload);
    expect(out).not.toBeNull();
    expect(out!.toLowerCase()).not.toContain('<iframe');
    expect(out!).not.toContain('evil.com');
  });

  it('strips <foreignObject> and any embedded on* handlers inside it', () => {
    const payload = `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject width="100" height="100"><body onload="alert(1)">text</body></foreignObject></svg>`;
    const out = svgBlockRender(payload);
    expect(out).not.toBeNull();
    expect(out!.toLowerCase()).not.toContain('foreignobject');
    expect(out!.toLowerCase()).not.toContain('onload');
    expect(out!).not.toContain('alert(1)');
  });

  it('strips javascript: URI from href on an <a> inside svg', () => {
    const payload = `<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><circle cx="10" cy="10" r="5"/></a></svg>`;
    const out = svgBlockRender(payload);
    expect(out).not.toBeNull();
    expect(out!.toLowerCase()).not.toContain('javascript:');
    expect(out!).not.toContain('alert(1)');
  });

  it('strips <animate> with onbegin handler', () => {
    const payload = `<svg xmlns="http://www.w3.org/2000/svg"><animate attributeName="x" from="0" to="100" dur="1s" onbegin="alert(1)"/></svg>`;
    const out = svgBlockRender(payload);
    expect(out).not.toBeNull();
    expect(out!.toLowerCase()).not.toContain('<animate');
    expect(out!.toLowerCase()).not.toContain('onbegin');
    expect(out!).not.toContain('alert(1)');
  });
});

describe('SvgBlock sanitization — external fetch vectors (tracking pixel / data exfiltration)', () => {
  it('[RED — external xlink:href on <image> may leak] blocks or warns on https xlink:href pointing at external domain', () => {
    const payload = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="https://evil.com/track.gif" width="100" height="100"/></svg>`;
    const out = svgBlockRender(payload);
    expect(out).not.toBeNull();
    // If this assertion fails, DOMPurify is allowing the external fetch — real exfiltration vector.
    // The expectation here pins the SAFE behavior we want; a failure means we need a hook or
    // additional FORBID_ATTR entry.
    expect(out!).not.toContain('evil.com');
  });

  it('[RED — external xlink:href on <use> may leak] blocks <use> with external https href', () => {
    const payload = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="https://evil.com/external.svg#x"/></svg>`;
    const out = svgBlockRender(payload);
    expect(out).not.toBeNull();
    // Expectation pins the desired safe behavior. If this fails, we need to fix the sanitize config.
    expect(out!).not.toContain('evil.com');
  });

  it('blocks data: URI schemes in xlink:href', () => {
    const payload = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==" width="100" height="100"/></svg>`;
    const out = svgBlockRender(payload);
    expect(out).not.toBeNull();
    // data: URI should be stripped — data: passes ALLOW_UNKNOWN_PROTOCOLS:false
    // because it's a "known" scheme, so the per-call href restrictor hook is
    // what actually blocks it.
    expect(out!.toLowerCase()).not.toContain('data:text/html');
  });
});

describe('SvgBlock sanitization — positive cases for legitimate in-document refs', () => {
  it('preserves <use xlink:href="#id"> pointing at an in-document <symbol> (per S34 T8 requirement 3, corrected target)', () => {
    // Jack's original brief said to test against linearGradient, but <use>
    // can't reference paint servers — only renderable elements like <symbol>.
    // The gradient case is split into its own test below. This test verifies
    // the href-restrictor hook preserves legitimate in-document fragment refs
    // on valid <use> targets.
    const payload = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><defs><symbol id="icon1"><circle cx="5" cy="5" r="4"/></symbol></defs><use xlink:href="#icon1" x="0" y="0"/></svg>`;
    const out = svgBlockRender(payload);
    expect(out).not.toBeNull();
    expect(out!).toContain('#icon1');
    expect(out!).toContain('<symbol');
    expect(out!).toContain('<use');
  });

  it('preserves <defs> + paint-server fragment refs (url(#id) in fill/stroke)', () => {
    // Separate test for the linearGradient case. <use> isn't expected to
    // survive here (it references a paint server, which is invalid SVG per
    // spec), but the gradient defs and the url(#grad1) reference from <rect>
    // must survive untouched.
    const payload = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><defs><linearGradient id="grad1"/></defs><rect fill="url(#grad1)" width="100" height="100"/></svg>`;
    const out = svgBlockRender(payload);
    expect(out).not.toBeNull();
    expect(out!).toContain('linearGradient');
    expect(out!).toContain('url(#grad1)');
  });

  it('preserves <a href="#section"> in-document link', () => {
    const payload = `<svg xmlns="http://www.w3.org/2000/svg"><a href="#section"><text>jump</text></a></svg>`;
    const out = svgBlockRender(payload);
    expect(out).not.toBeNull();
    expect(out!).toContain('#section');
    expect(out!).toContain('<a');
  });
});

describe('SvgBlock sanitization — hook isolation (no global contamination)', () => {
  it('does not leak the href-restrictor hook to other DOMPurify consumers', async () => {
    // Call sanitizeSvg — this should add+sanitize+remove the hook in a finally block
    sanitizeSvg(`<svg xmlns="http://www.w3.org/2000/svg"><image xlink:href="https://example.com/a.png"/></svg>`);

    // Now call DOMPurify.sanitize directly (as the chat renderer or another
    // component would). The external href should NOT be stripped because the
    // hook should have been removed by the finally block.
    const DOMPurify = (await import('dompurify')).default;
    const unrelatedHtml = '<a href="https://example.com/post">click</a>';
    const unrelatedOut = DOMPurify.sanitize(unrelatedHtml);
    expect(unrelatedOut).toContain('example.com');
    expect(unrelatedOut).toContain('href="https://example.com/post"');
  });

  it('removes the hook even if sanitize throws inside', async () => {
    const DOMPurify = (await import('dompurify')).default;
    // Force an error by passing an invalid type — catch and verify that a
    // subsequent plain sanitize call is not affected.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sanitizeSvg(null as any);
    } catch {
      /* expected */
    }
    // Now a direct DOMPurify call should still work without the hook active
    const out = DOMPurify.sanitize('<a href="https://safe.example.com/page">link</a>');
    expect(out).toContain('href="https://safe.example.com/page"');
  });
});

describe('SvgBlock component wrapper — SSR, size cap, empty, valid', () => {
  it('returns empty string when window is undefined (SSR)', () => {
    // Temporarily remove window to simulate SSR
    const originalWindow = globalThis.window;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).window;
    try {
      expect(sanitizeSvg('<svg><circle cx="1" cy="1" r="1"/></svg>')).toBe('');
    } finally {
      globalThis.window = originalWindow;
    }
  });

  it('returns null for oversized (>10KB) markup', () => {
    const oversized = '<svg>' + 'x'.repeat(10_000) + '</svg>';
    expect(svgBlockRender(oversized)).toBeNull();
  });

  it('returns null for empty or whitespace-only markup', () => {
    expect(svgBlockRender('')).toBeNull();
    expect(svgBlockRender('   \n  ')).toBeNull();
  });

  it('preserves a benign svg with viewBox + circle', () => {
    const payload = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>`;
    const out = svgBlockRender(payload);
    expect(out).not.toBeNull();
    expect(out!.toLowerCase()).toContain('<svg');
    expect(out!).toContain('circle');
    expect(out!).toContain('viewBox="0 0 100 100"');
  });

  it('returns null for markup that does not contain an svg element (post-sanitize)', () => {
    // A raw <script> wouldn't survive sanitize and the wrapper also requires '<svg' in output
    const payload = '<script>alert(1)</script>';
    expect(svgBlockRender(payload)).toBeNull();
  });
});
