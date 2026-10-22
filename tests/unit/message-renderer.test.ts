import { afterEach, describe, it, expect, vi } from 'vitest';
import type { ReactElement } from 'react';
import { parseTokens, getBlockType } from '@/lib/message-parser';
import { renderMessageContent } from '@/lib/message-renderer';
import PathChip from '@/components/PathChip';

// ─── parseTokens ─────────────────────────────────────────────────────────────

describe('parseTokens — basic tokens', () => {
  it('returns [] for empty string', () => {
    expect(parseTokens('')).toEqual([]);
  });

  it('returns [] for plain text with no tokens', () => {
    expect(parseTokens('Hello world')).toEqual([]);
  });

  it('captures bold token', () => {
    const tokens = parseTokens('say **hello** there');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('bold');
    expect(tokens[0].inner).toBe('hello');
    expect(tokens[0].start).toBe(4);
  });

  it('captures italic token', () => {
    const tokens = parseTokens('say *hello* there');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('italic');
    expect(tokens[0].inner).toBe('hello');
  });

  it('does not treat ** as italic', () => {
    const tokens = parseTokens('**bold**');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('bold');
  });

  it('captures inline-code token', () => {
    const tokens = parseTokens('run `npm install` first');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('inline-code');
    expect(tokens[0].inner).toBe('npm install');
  });

  it('captures underline token', () => {
    const tokens = parseTokens('this is <u>important</u> text');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('underline');
    expect(tokens[0].inner).toBe('important');
  });

  it('captures url token for http URL', () => {
    const tokens = parseTokens('see https://example.com for details');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('url');
    expect(tokens[0].value).toBe('https://example.com');
  });

  it('captures url token for localhost URL', () => {
    const tokens = parseTokens('open localhost:3000/dashboard');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('url');
  });

  it('captures a named Markdown link with a spaced filesystem target as one token', () => {
    const content = '[open the plan](</home/user/AM New Website/review plan.md>)';
    const tokens = parseTokens(content);

    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({
      type: 'markdown-link',
      value: content,
      linkLabel: 'open the plan',
      linkTarget: '/home/user/AM New Website/review plan.md',
    });
  });

  it('captures a named HTTPS link without duplicating its inner URL', () => {
    const tokens = parseTokens('[visit Acme](https://acmemedia.co.uk/work)');

    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('markdown-link');
    expect(tokens[0].linkTarget).toBe('https://acmemedia.co.uk/work');
  });

  it('captures mention token', () => {
    const tokens = parseTokens('hey @Alice what do you think');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('mention');
    expect(tokens[0].mentionName).toBe('Alice');
  });

  it('does not treat the domain half of an email address as a mention', () => {
    const tokens = parseTokens('reach me at user@example.com');
    expect(tokens.map(t => t.type)).not.toContain('mention');
  });

  it('still captures a mention immediately after punctuation', () => {
    const tokens = parseTokens('(@Daniel) can you check this');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('mention');
    expect(tokens[0].mentionName).toBe('Daniel');
  });

  it('still captures a leading mention at the start of a message', () => {
    const tokens = parseTokens('@Daniel please take a look');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('mention');
    expect(tokens[0].mentionName).toBe('Daniel');
  });
});

describe('renderMessageContent — named links', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('renders saved AgentChat attachments as labelled hyperlinks', () => {
    const target = '/api/collab/images/message-1-0.png';
    const rendered = renderMessageContent(`[Image 1](${target})`, []);

    expect(Array.isArray(rendered)).toBe(true);
    const element = (rendered as ReactElement<{ href: string; children: unknown }>[])[0];
    expect(element.type).toBe('a');
    expect(element.props.href).toBe(target);
  });

  it('renders a spaced Linux path target as one labelled PathChip', () => {
    const target = '/home/user/AM New Website/review plan.md';
    const rendered = renderMessageContent(`[open the plan](<${target}>)`, []);

    expect(Array.isArray(rendered)).toBe(true);
    const element = (rendered as ReactElement<{ path: string; label: string }>[])[0];
    expect(element.type).toBe(PathChip);
    expect(element.props).toMatchObject({ path: target, label: 'open the plan' });
  });

  it('leaves unsupported link schemes inert', () => {
    const content = '[unsafe](javascript:evil)';
    expect(renderMessageContent(content, [])).toEqual([content]);
  });

  it('opens a loopback secure handoff link in a dedicated browser window', () => {
    const href = 'http://127.0.0.1:7007/account-browser-handoff/11111111-1111-4111-8111-111111111111#capability';
    const focus = vi.fn();
    const popup = { opener: {}, focus };
    const open = vi.fn(() => popup);
    vi.stubGlobal('window', { open });
    const rendered = renderMessageContent(`[Open browser](${href})`, []);
    const element = (rendered as ReactElement<{ onClick: (event: { preventDefault: () => void }) => void }>[])[0];
    const preventDefault = vi.fn();

    element.props.onClick({ preventDefault });

    expect(open).toHaveBeenCalledWith(
      href,
      'devflowSecureBrowserHandoff',
      'popup,width=1500,height=1000,resizable=yes,scrollbars=yes',
    );
    expect(popup.opener).toBeNull();
    expect(focus).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it('leaves ordinary web links on their normal new-tab path', () => {
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    const rendered = renderMessageContent('[Example](https://example.com)', []);
    const element = (rendered as ReactElement<{ onClick: (event: { preventDefault: () => void }) => void }>[])[0];
    const preventDefault = vi.fn();

    element.props.onClick({ preventDefault });

    expect(open).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });
});

// ─── parseTokens — code blocks ───────────────────────────────────────────────

describe('parseTokens — code blocks (language tag)', () => {
  it('captures untagged code block with empty language (backward compat)', () => {
    const tokens = parseTokens('```\nsome code\n```');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('code-block');
    expect(tokens[0].language).toBe('');
    expect(tokens[0].inner).toContain('some code');
  });

  it('first word after ``` with no newline is captured as language tag (new behaviour)', () => {
    // ```word``` → language='word', inner='' (word is the tag, nothing after it)
    const tokens = parseTokens('```word```');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('code-block');
    expect(tokens[0].language).toBe('word');
  });

  it('captures chart language tag', () => {
    const tokens = parseTokens('```chart\n{"type":"bar"}\n```');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].type).toBe('code-block');
    expect(tokens[0].language).toBe('chart');
    expect(tokens[0].inner).toContain('{"type":"bar"}');
  });

  it('captures mermaid language tag', () => {
    const tokens = parseTokens('```mermaid\ngraph TD\nA-->B\n```');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].language).toBe('mermaid');
  });

  it('captures svg language tag', () => {
    const tokens = parseTokens('```svg\n<svg/>\n```');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].language).toBe('svg');
  });

  it('captures progress language tag', () => {
    const tokens = parseTokens('```progress\n75\n```');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].language).toBe('progress');
  });

  it('captures javascript language tag (standard code — not a rich block)', () => {
    const tokens = parseTokens('```javascript\nconsole.log(1)\n```');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].language).toBe('javascript');
  });

  it('stores code-block start/end positions correctly', () => {
    const content = 'before ```chart\nspec``` after';
    const tokens = parseTokens(content);
    const cb = tokens.find(t => t.type === 'code-block');
    expect(cb).toBeDefined();
    expect(cb!.start).toBe(7); // 'before '.length
    expect(cb!.end).toBe(content.indexOf(' after'));
  });
});

// ─── parseTokens — overlap prevention ───────────────────────────────────────

describe('parseTokens — overlap prevention', () => {
  it('does not capture inline-code inside a code-block', () => {
    const tokens = parseTokens('```\nrun `npm install`\n```');
    const types = tokens.map(t => t.type);
    expect(types).not.toContain('inline-code');
    expect(types).toContain('code-block');
  });

  it('does not capture url inside a code-block', () => {
    const tokens = parseTokens('```\nhttps://example.com\n```');
    const types = tokens.map(t => t.type);
    expect(types).not.toContain('url');
  });

  it('does not capture a Markdown link inside a code-block', () => {
    const tokens = parseTokens('```\n[plan](</home/user/My Project/plan.md>)\n```');
    expect(tokens.map(t => t.type)).toEqual(['code-block']);
  });

  it('does not capture underline markup inside a code-block', () => {
    const tokens = parseTokens('```html\n<u>literal markup</u>\n```');
    const types = tokens.map(t => t.type);
    expect(types).not.toContain('underline');
    expect(types).toContain('code-block');
  });

  it('tokens are sorted by start position', () => {
    const tokens = parseTokens('**bold** and *italic* and `code`');
    for (let i = 1; i < tokens.length; i++) {
      expect(tokens[i].start).toBeGreaterThan(tokens[i - 1].start);
    }
  });
});

// ─── getBlockType ─────────────────────────────────────────────────────────────

describe('getBlockType — dispatch mapping', () => {
  it('maps chart → chart', () => expect(getBlockType('chart')).toBe('chart'));
  it('maps mermaid → mermaid', () => expect(getBlockType('mermaid')).toBe('mermaid'));
  it('maps svg → svg', () => expect(getBlockType('svg')).toBe('svg'));
  it('maps progress → progress', () => expect(getBlockType('progress')).toBe('progress'));
  it('maps javascript → code (standard code block)', () => expect(getBlockType('javascript')).toBe('code'));
  it('maps empty string → code', () => expect(getBlockType('')).toBe('code'));
  it('maps python → code', () => expect(getBlockType('python')).toBe('code'));
  it('is case-insensitive for rich types', () => {
    expect(getBlockType('CHART')).toBe('chart');
    expect(getBlockType('Mermaid')).toBe('mermaid');
    expect(getBlockType('SVG')).toBe('svg');
    expect(getBlockType('PROGRESS')).toBe('progress');
  });
});
