/**
 * message-parser.ts
 * Pure token parsing logic for the chat message renderer.
 * No React dependency — fully testable in a node environment.
 */

export type TokenType = 'url' | 'markdown-link' | 'mention' | 'code-block' | 'inline-code' | 'bold' | 'italic' | 'underline';
export type BlockLanguage = 'chart' | 'mermaid' | 'svg' | 'progress' | 'html' | 'sandbox' | 'code';

export interface Token {
  type: TokenType;
  start: number;
  end: number;
  value: string;
  inner?: string;
  language?: string;
  mentionName?: string;
  linkLabel?: string;
  linkTarget?: string;
}

/**
 * Parse a message string into an array of tokens, sorted by position.
 * Tokens do not overlap — later regex passes skip positions already claimed.
 */
export function parseTokens(content: string): Token[] {
  const tokens: Token[] = [];

  // Language tag now captured: ```(\w*)\n?([\s\S]*?)```
  const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g;
  const inlineCodeRegex = /`([^`\n]+)`/g;
  const underlineRegex = /<u>([\s\S]*?)<\/u>/gi;
  const boldRegex = /\*\*([^*]+)\*\*/g;
  const italicRegex = /(?<!\*)\*([^*]+)\*(?!\*)/g;
  // Angle brackets are the CommonMark form for destinations containing
  // spaces: [label](</home/user/My Project/file.md>). The non-angle form is
  // intentionally whitespace-free so prose cannot be swallowed as a target.
  const markdownLinkRegex = /\[([^\]\n]+)\]\(\s*(?:<([^>\n]+)>|([^\s)\n]+))\s*\)/g;
  const urlRegex = /(https?:\/\/[^\s<>]+|localhost:\d+[^\s<>]*|www\.[^\s<>]+\.[a-z]{2,}[^\s<>]*)/gi;
  // Negative lookbehind excludes '@' preceded by a word char, so email
  // addresses like user@example.com are left untouched while
  // "Hi @Daniel" / "(@Daniel)" / a leading "@Daniel" still match.
  const mentionRegex = /(?<!\w)@([\w'-]+)/g;

  let match: RegExpExecArray | null;

  // Code blocks first — highest priority, claim their range before anything else
  while ((match = codeBlockRegex.exec(content)) !== null) {
    tokens.push({
      type: 'code-block',
      start: match.index,
      end: match.index + match[0].length,
      value: match[0],
      language: match[1] || '',
      inner: match[2],
    });
  }

  const isInside = (idx: number) => tokens.some(t => idx >= t.start && idx < t.end);

  while ((match = inlineCodeRegex.exec(content)) !== null) {
    if (!isInside(match.index)) {
      tokens.push({
        type: 'inline-code',
        start: match.index,
        end: match.index + match[0].length,
        value: match[0],
        inner: match[1],
      });
    }
  }

  // Claim complete Markdown links before styling and URL passes. Otherwise a
  // spaced filesystem destination is split into multiple false path chips.
  while ((match = markdownLinkRegex.exec(content)) !== null) {
    if (!isInside(match.index)) {
      tokens.push({
        type: 'markdown-link',
        start: match.index,
        end: match.index + match[0].length,
        value: match[0],
        linkLabel: match[1],
        linkTarget: match[2] ?? match[3],
      });
    }
  }

  while ((match = underlineRegex.exec(content)) !== null) {
    if (!isInside(match.index)) {
      tokens.push({
        type: 'underline',
        start: match.index,
        end: match.index + match[0].length,
        value: match[0],
        inner: match[1],
      });
    }
  }

  while ((match = boldRegex.exec(content)) !== null) {
    if (!isInside(match.index)) {
      tokens.push({
        type: 'bold',
        start: match.index,
        end: match.index + match[0].length,
        value: match[0],
        inner: match[1],
      });
    }
  }

  while ((match = italicRegex.exec(content)) !== null) {
    if (!isInside(match.index)) {
      tokens.push({
        type: 'italic',
        start: match.index,
        end: match.index + match[0].length,
        value: match[0],
        inner: match[1],
      });
    }
  }

  while ((match = urlRegex.exec(content)) !== null) {
    if (!isInside(match.index)) {
      tokens.push({
        type: 'url',
        start: match.index,
        end: match.index + match[0].length,
        value: match[0],
      });
    }
  }

  while ((match = mentionRegex.exec(content)) !== null) {
    if (!isInside(match.index)) {
      tokens.push({
        type: 'mention',
        start: match.index,
        end: match.index + match[0].length,
        value: match[0],
        mentionName: match[1],
      });
    }
  }

  tokens.sort((a, b) => a.start - b.start);
  return tokens;
}

/* ─── Block-level markdown (headings + lists) ──────────────────────────────
 * The inline tokenizer above renders marks within a line. Headings and lists
 * are block-level: the composer now lets the owner build them visually (WYSIWYG), so
 * the rendered message must show them as real <h2>/<ul> too — not literal "##"
 * / "- ". Fenced code is treated as opaque so its contents are never reparsed.
 */
export type MessageBlock =
  | { type: 'fence'; value: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'paragraph'; text: string };

const HEADING_RE = /^(#{1,3})\s+(\S.*)$/;
const UL_ITEM_RE = /^[ \t]*[-*]\s+(\S.*)$/;
const OL_ITEM_RE = /^[ \t]*\d+\.\s+(\S.*)$/;

/** Split content into fenced-code segments (opaque) and plain text segments. */
function splitFenceSegments(content: string): { type: 'fence' | 'text'; value: string }[] {
  const re = /```(\w*)\n?[\s\S]*?```/g;
  const segs: { type: 'fence' | 'text'; value: string }[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m.index > last) segs.push({ type: 'text', value: content.slice(last, m.index) });
    segs.push({ type: 'fence', value: m[0] });
    last = m.index + m[0].length;
  }
  if (last < content.length) segs.push({ type: 'text', value: content.slice(last) });
  return segs;
}

/**
 * Cheap gate: true only if some non-fenced line is a markdown heading or list
 * item. When false, the renderer takes the original inline-only path unchanged —
 * so messages without block markdown render exactly as before (no regression).
 */
export function hasBlockMarkdown(content: string): boolean {
  for (const seg of splitFenceSegments(content)) {
    if (seg.type !== 'text') continue;
    for (const line of seg.value.split('\n')) {
      if (HEADING_RE.test(line) || UL_ITEM_RE.test(line) || OL_ITEM_RE.test(line)) return true;
    }
  }
  return false;
}

/** Parse content into block-level structure (headings, lists, paragraphs, fences). */
export function parseBlocks(content: string): MessageBlock[] {
  const blocks: MessageBlock[] = [];

  for (const seg of splitFenceSegments(content)) {
    if (seg.type === 'fence') {
      blocks.push({ type: 'fence', value: seg.value });
      continue;
    }

    const lines = seg.value.split('\n');
    let para: string[] = [];
    let list: { ordered: boolean; items: string[] } | null = null;

    const flushPara = () => {
      const text = para.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
      if (text.length > 0) blocks.push({ type: 'paragraph', text });
      para = [];
    };
    const flushList = () => {
      if (list) blocks.push({ type: 'list', ordered: list.ordered, items: list.items });
      list = null;
    };

    for (const line of lines) {
      const h = HEADING_RE.exec(line);
      const ul = UL_ITEM_RE.exec(line);
      const ol = OL_ITEM_RE.exec(line);
      if (h) {
        flushPara();
        flushList();
        blocks.push({ type: 'heading', level: h[1].length, text: h[2] });
      } else if (ul) {
        flushPara();
        if (list && !list.ordered) list.items.push(ul[1]);
        else {
          flushList();
          list = { ordered: false, items: [ul[1]] };
        }
      } else if (ol) {
        flushPara();
        if (list && list.ordered) list.items.push(ol[1]);
        else {
          flushList();
          list = { ordered: true, items: [ol[1]] };
        }
      } else {
        flushList();
        para.push(line);
      }
    }
    flushList();
    flushPara();
  }

  return blocks;
}

/**
 * Map a code-block language tag to a dispatch category.
 * Rich block languages get their own component; everything else renders as <pre>.
 */
export function getBlockType(language: string): BlockLanguage {
  switch (language.toLowerCase()) {
    case 'chart':    return 'chart';
    case 'mermaid':  return 'mermaid';
    case 'svg':      return 'svg';
    case 'progress': return 'progress';
    case 'html':     return 'html';
    case 'sandbox':  return 'sandbox';
    default:         return 'code';
  }
}
