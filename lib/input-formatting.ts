/**
 * Pure text-formatting helpers for the AgentChat composer toolbar.
 * No React, no DOM — operates on (value, selStart, selEnd) and returns the new
 * value plus the caret/selection to restore. Fully unit-testable in node.
 */

export type FormatAction = 'heading' | 'bullet' | 'inline-code' | 'code-block';

export interface FormatResult {
  value: string;
  selStart: number;
  selEnd: number;
}

const LINE_PREFIX: Record<'heading' | 'bullet', string> = {
  heading: '## ',
  bullet: '- ',
};

export function applyFormat(
  action: FormatAction,
  value: string,
  selStart: number,
  selEnd: number,
): FormatResult {
  switch (action) {
    case 'inline-code':
      return wrapInline(value, selStart, selEnd, '`');
    case 'heading':
    case 'bullet':
      return toggleLinePrefix(value, selStart, selEnd, LINE_PREFIX[action]);
    case 'code-block':
      return fenceBlock(value, selStart, selEnd);
  }
}

// ─── inline wrap (toggleable) ────────────────────────────────────────────────

function wrapInline(value: string, selStart: number, selEnd: number, marker: string): FormatResult {
  const before = value.slice(0, selStart);
  const selected = value.slice(selStart, selEnd);
  const after = value.slice(selEnd);
  const m = marker.length;

  // No selection → insert an empty pair, caret between the markers.
  if (selStart === selEnd) {
    return {
      value: before + marker + marker + after,
      selStart: selStart + m,
      selEnd: selStart + m,
    };
  }

  // Selection already wrapped by the marker → unwrap (toggle off).
  if (
    selected.length >= 2 * m &&
    selected.startsWith(marker) &&
    selected.endsWith(marker)
  ) {
    const inner = selected.slice(m, selected.length - m);
    return {
      value: before + inner + after,
      selStart,
      selEnd: selStart + inner.length,
    };
  }

  // Wrap, keeping the inner text selected.
  return {
    value: before + marker + selected + marker + after,
    selStart: selStart + m,
    selEnd: selEnd + m,
  };
}

// ─── line prefix (toggleable) ────────────────────────────────────────────────

function toggleLinePrefix(value: string, selStart: number, selEnd: number, prefix: string): FormatResult {
  const blockStart = value.lastIndexOf('\n', selStart - 1) + 1;
  const nextNl = value.indexOf('\n', selEnd);
  const blockEnd = nextNl === -1 ? value.length : nextNl;

  const block = value.slice(blockStart, blockEnd);
  const lines = block.split('\n');
  const allPrefixed = lines.every((l) => l.startsWith(prefix));

  const newBlock = allPrefixed
    ? lines.map((l) => l.slice(prefix.length)).join('\n')
    : lines.map((l) => prefix + l).join('\n');

  return {
    value: value.slice(0, blockStart) + newBlock + value.slice(blockEnd),
    selStart: blockStart,
    selEnd: blockStart + newBlock.length,
  };
}

// ─── fenced code block ───────────────────────────────────────────────────────

function fenceBlock(value: string, selStart: number, selEnd: number): FormatResult {
  const before = value.slice(0, selStart);
  const selected = value.slice(selStart, selEnd);
  const after = value.slice(selEnd);

  // Only add a leading newline when preceding text exists and isn't already
  // newline-terminated, so the opening fence sits on its own line.
  const lead = before.length > 0 && !before.endsWith('\n') ? '\n' : '';

  if (selStart === selEnd) {
    // Empty fence; caret on the blank middle line ready for code.
    const insert = lead + '```\n\n```';
    const caret = before.length + lead.length + 4; // after "```\n"
    return { value: before + insert + after, selStart: caret, selEnd: caret };
  }

  const open = lead + '```\n';
  const innerStart = before.length + open.length;
  return {
    value: before + open + selected + '\n```' + after,
    selStart: innerStart,
    selEnd: innerStart + selected.length,
  };
}
