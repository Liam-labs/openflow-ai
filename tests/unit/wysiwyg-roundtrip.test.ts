// @vitest-environment jsdom
/**
 * W0.1 — Markdown round-trip confirmation for the WYSIWYG composer.
 *
 * Gate: the rich-text editor must round-trip markdown <-> rich content so the
 * existing lib/prompt-parser keeps consuming clean markdown on send. This test
 * is the empirical proof that the chosen lib (TipTap v3 + tiptap-markdown)
 * survives the four toolbar formats AND preserves the literal text that the
 * @mention / :emoji: / /slash autocompletes depend on.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Editor } from '@tiptap/core';
// The REAL shipped extension set (StarterKit + clean-wire Text/HardBreak overrides
// + Markdown config) — imported so this gate can't drift from the composer.
import { composerExtensions } from '../../components/RichComposer';

// jsdom doesn't implement elementFromPoint; TipTap v3.25's Placeholder viewport
// tracking calls it on editor mount. Stub it so the exact shipped extension set
// (including Placeholder) can mount headlessly.
beforeAll(() => {
  Object.defineProperty(document, 'elementFromPoint', {
    value: () => null,
    configurable: true,
  });
});

function makeEditor(): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: composerExtensions(),
    content: '',
  });
}

function getMd(editor: Editor): string {
  const storage = editor.storage as unknown as { markdown: { getMarkdown: () => string } };
  return storage.markdown.getMarkdown();
}

/** markdown -> rich doc -> markdown, trimmed (handleSend trims before dispatch). */
function roundTrip(md: string): string {
  const editor = makeEditor();
  editor.commands.setContent(md);
  const out = getMd(editor);
  editor.destroy();
  return out.trim();
}

/** Serialize a programmatically-built doc — simulates what TYPING produces. */
function serializeDoc(paragraphContent: object[]): string {
  const editor = makeEditor();
  editor.commands.setContent({
    type: 'doc',
    content: [{ type: 'paragraph', content: paragraphContent }],
  });
  const out = getMd(editor);
  editor.destroy();
  return out;
}

describe('WYSIWYG markdown round-trip (TipTap v3 + tiptap-markdown)', () => {
  it('plain paragraph survives unchanged', () => {
    expect(roundTrip('Hello world')).toBe('Hello world');
  });

  it('H2 heading round-trips as ## (no #-wrap bug)', () => {
    expect(roundTrip('## Section title')).toBe('## Section title');
  });

  it('bullet list round-trips as real list, not literal hyphens', () => {
    expect(roundTrip('- one\n- two\n- three')).toBe('- one\n- two\n- three');
  });

  it('inline code round-trips with backticks intact', () => {
    expect(roundTrip('Run `npm install` first')).toBe('Run `npm install` first');
  });

  it('fenced code block round-trips with language hint', () => {
    expect(roundTrip('```js\nconst a = 1;\n```')).toBe('```js\nconst a = 1;\n```');
  });

  it('preserves @mention / :emoji: / /slash as literal text (autocomplete contract)', () => {
    const s = '@Daniel :smile: /audit please';
    expect(roundTrip(s)).toBe(s);
  });

  it('keeps plain URLs literal (no [url](url) link-wrapping)', () => {
    const s = 'Visit https://example.com/path?q=1 and localhost:3000 now';
    expect(roundTrip(s)).toBe(s);
  });

  it('preserves a pending attachment reference until the server resolves it', () => {
    const reference = '[Image 1](attachment:upload-123)';
    expect(roundTrip(`Use ${reference} here`)).toBe(`Use ${reference} here`);
  });

  it('serializes a WYSIWYG attachment link mark with its internal target', () => {
    expect(serializeDoc([
      { type: 'text', text: 'See ' },
      {
        type: 'text',
        text: 'Image 1',
        marks: [{ type: 'link', attrs: { href: 'attachment:upload-123' } }],
      },
      { type: 'text', text: ' here' },
    ]).trim()).toBe('See [Image 1](attachment:upload-123) here');
  });

  it('bold + italic round-trip (chat renderer already supports these)', () => {
    expect(roundTrip('Some **bold** and *italic* text')).toBe('Some **bold** and *italic* text');
  });

  it('mixed document round-trips (heading + paragraph + bullets + code)', () => {
    const md = ['## Plan', '', 'Steps:', '', '- build', '- test', '', '```ts', 'run();', '```'].join('\n');
    expect(roundTrip(md)).toBe(md);
  });
});

/**
 * Clean wire format — the serialized markdown is consumed raw by AI agents and
 * by lib/message-renderer.tsx (a markdown subset with NO backslash-escape
 * support), so the CommonMark escaping tiptap-markdown does by default must
 * stay disabled. Guards the PlainText/PlainHardBreak overrides in RichComposer.
 */
describe('clean wire format (no CommonMark escaping)', () => {
  it('does not backslash-escape punctuation (`~/.secrets` stays literal)', () => {
    expect(roundTrip('source ~/.secrets first')).toBe('source ~/.secrets first');
  });

  it('Shift+Enter hard break serializes as plain \\n, not `\\` + newline', () => {
    // Doc built the way typing builds it: text + hardBreak + text.
    const out = serializeDoc([
      { type: 'text', text: 'a~/b' },
      { type: 'hardBreak' },
      { type: 'text', text: 'c' },
    ]);
    expect(out.replace(/\n+$/, '')).toBe('a~/b\nc');
  });

  it('trailing hard break emits no phantom content', () => {
    const out = serializeDoc([{ type: 'text', text: 'a' }, { type: 'hardBreak' }]);
    expect(out.replace(/\n+$/, '')).toBe('a');
  });

  it('multi-line text round-trips with breaks:true (draft restore keeps lines)', () => {
    // Serialize (hardBreak -> "\n"), parse back (breaks:true maps "\n" -> hardBreak),
    // serialize again — the exact path of draft restore / load-last / send-clear.
    expect(roundTrip('line1\nline2\nline3')).toBe('line1\nline2\nline3');
  });

  it('special characters inside list items stay literal', () => {
    expect(roundTrip('- check ~/.secrets\n- run *carefully*')).toBe('- check ~/.secrets\n- run *carefully*');
  });
});
