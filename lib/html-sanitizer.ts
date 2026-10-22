import DOMPurify from 'dompurify';

/**
 * Tags unconditionally stripped from all HTML/SVG content.
 * Shared by SvgBlock (SVG-specific profile layered on top) and HtmlBlock.
 */
export const FORBID_TAGS = [
  'script',
  'iframe',
  'object',
  'embed',
  'foreignObject',
  'style',
  'animate',
  'set',
];

/**
 * Attributes unconditionally stripped from all elements.
 * Covers all known event handlers plus srcdoc (embedded document source).
 */
export const FORBID_ATTRS = [
  'onabort', 'onactivate', 'onbegin', 'oncancel', 'oncanplay',
  'oncanplaythrough', 'onclick', 'onclose', 'oncopy', 'oncuechange',
  'oncut', 'ondblclick', 'ondrag', 'ondragend', 'ondragenter', 'ondragleave',
  'ondragover', 'ondragstart', 'ondrop', 'ondurationchange', 'onemptied',
  'onend', 'onended', 'onerror', 'onfocus', 'oninput', 'oninvalid',
  'onkeydown', 'onkeypress', 'onkeyup', 'onload', 'onloadeddata',
  'onloadedmetadata', 'onloadstart', 'onmousedown', 'onmouseenter',
  'onmouseleave', 'onmousemove', 'onmouseout', 'onmouseover', 'onmouseup',
  'onmousewheel', 'onpaste', 'onpause', 'onplay', 'onplaying', 'onprogress',
  'onratechange', 'onrepeat', 'onreset', 'onresize', 'onscroll',
  'onseeked', 'onseeking', 'onselect', 'onshow', 'onstalled', 'onsubmit',
  'onsuspend', 'ontimeupdate', 'ontoggle', 'onunload', 'onvolumechange',
  'onwaiting', 'onwheel',
  'srcdoc',
];

export function sanitizeHtml(dirty: string): string {
  if (typeof window === 'undefined') return '';

  return DOMPurify.sanitize(dirty, {
    FORBID_TAGS,
    FORBID_ATTR: FORBID_ATTRS,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
  });
}
