// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { buildRichClipboardHtml, buildSelectionClipboardPayload } from '@/lib/chat-rich-clipboard';

describe('AgentChat rich clipboard', () => {
  it('turns CSS-only message newlines into portable HTML line breaks', () => {
    const message = document.createElement('div');
    message.className = 'text-sm whitespace-pre-wrap text-white';
    message.textContent = 'Hi Lily,\n\nHope the shoot went well.\n\nThanks,\nPete';

    expect(buildRichClipboardHtml(message)).toBe(
      '<div>Hi Lily,<br><br>Hope the shoot went well.<br><br>Thanks,<br>Pete</div>',
    );
  });

  it('preserves semantic formatting while removing AgentChat presentation styles', () => {
    const message = document.createElement('div');
    message.innerHTML = '<strong class="font-semibold">Important</strong> <em style="color:white">today</em> ' +
      '<a class="collab-link" href="https://example.com" target="_blank">details<svg></svg></a>';

    expect(buildRichClipboardHtml(message)).toBe(
      '<div><strong>Important</strong> <em>today</em> <a href="https://example.com">details</a></div>',
    );
  });

  it('builds both plain and HTML formats for a browser selection', () => {
    const message = document.createElement('div');
    message.textContent = 'First line\n\nSecond line';
    document.body.appendChild(message);
    const range = document.createRange();
    range.selectNodeContents(message);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    expect(buildSelectionClipboardPayload(selection)).toEqual({
      text: 'First line\n\nSecond line',
      html: 'First line<br><br>Second line',
    });
  });
});
