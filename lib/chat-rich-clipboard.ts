const SAFE_LINK_RE = /^(?:https?:\/\/|mailto:|\/)/i;

export interface RichClipboardPayload {
  text: string;
  html: string;
}

/**
 * Turn the rendered message DOM into a small, portable HTML fragment.
 *
 * AgentChat renders plain message line breaks with CSS `white-space: pre-wrap`.
 * That looks correct in the browser, but the CSS is lost when Outlook consumes
 * the clipboard HTML, so all paragraphs collapse into one. Convert those text
 * newlines to real <br> nodes and discard AgentChat's visual classes/styles.
 */
export function buildRichClipboardHtml(node: Node): string {
  const documentRef = node.ownerDocument ?? document;
  const container = documentRef.createElement('div');
  container.appendChild(node.cloneNode(true));

  container.querySelectorAll('svg, button, script, style').forEach(element => element.remove());

  const textNodes: Text[] = [];
  const walker = documentRef.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current) {
    textNodes.push(current as Text);
    current = walker.nextNode();
  }

  for (const textNode of textNodes) {
    if (!textNode.data.includes('\n')) continue;
    const fragment = documentRef.createDocumentFragment();
    const lines = textNode.data.replace(/\r\n?/g, '\n').split('\n');
    lines.forEach((line, index) => {
      if (index > 0) fragment.appendChild(documentRef.createElement('br'));
      if (line) fragment.appendChild(documentRef.createTextNode(line));
    });
    textNode.replaceWith(fragment);
  }

  container.querySelectorAll<HTMLElement>('*').forEach(element => {
    const href = element.tagName === 'A' ? element.getAttribute('href') : null;
    for (const attribute of Array.from(element.attributes)) {
      element.removeAttribute(attribute.name);
    }
    if (href && SAFE_LINK_RE.test(href)) element.setAttribute('href', href);
  });

  return container.innerHTML;
}

export function buildSelectionClipboardPayload(selection: Selection): RichClipboardPayload | null {
  if (selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  return {
    text: selection.toString(),
    html: buildRichClipboardHtml(range.cloneContents()),
  };
}

export async function writeRichClipboard(payload: RichClipboardPayload): Promise<void> {
  if (payload.html && typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([payload.text], { type: 'text/plain' }),
          'text/html': new Blob([payload.html], { type: 'text/html' }),
        }),
      ]);
      return;
    } catch {
      // Some browsers expose ClipboardItem but reject rich writes. Keep the
      // existing plain-text path as the compatibility fallback.
    }
  }
  await navigator.clipboard.writeText(payload.text);
}
