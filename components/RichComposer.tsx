'use client';
import React from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import { Text } from '@tiptap/extension-text';
import { HardBreak } from '@tiptap/extension-hard-break';
import Link from '@tiptap/extension-link';
import { Markdown } from 'tiptap-markdown';
import type { Node as PMNode } from '@tiptap/pm/model';

/** tiptap-markdown augments editor.storage with a markdown serializer. */
interface MarkdownStorage {
  markdown: { getMarkdown: () => string };
}
function getMarkdown(editor: Editor): string {
  return (editor.storage as unknown as MarkdownStorage).markdown.getMarkdown();
}

/**
 * Clean-wire serialization overrides.
 *
 * tiptap-markdown serializes through prosemirror-markdown, which emits escaped
 * CommonMark: punctuation gets backslash-escaped (`~/.secrets` → `\~/.secrets`)
 * and a hardBreak (Shift+Enter) becomes `\` + newline. Our wire format is read
 * raw by AI agents and by lib/message-renderer.tsx (a markdown subset with no
 * backslash-escape support), so it must stay clean human-readable text.
 *
 * tiptap-markdown@0.9.0 resolves each extension's spec via getMarkdownSpec(),
 * which prefers the extension's own `storage.markdown` over the library default
 * (spread order `{...default, ...custom}`). Extending the real Text/HardBreak
 * nodes with a custom spec therefore replaces only the serialize behaviour —
 * schema, commands and keyboard shortcuts are inherited unchanged. StarterKit's
 * copies are disabled below so these are the registered `text`/`hardBreak`
 * nodes the serializer maps by name.
 */
interface MarkdownSerializeState {
  /** prosemirror-markdown state.text — escape=false writes the text verbatim. */
  text(text: string, escape?: boolean): void;
  write(content?: string): void;
}

const PlainText = Text.extend({
  addStorage() {
    return {
      markdown: {
        // Library default is state.text(escapeHTML(node.text)) — escapes both
        // markdown punctuation and HTML entities. Emit the text exactly as typed.
        serialize(state: MarkdownSerializeState, node: PMNode) {
          state.text(node.text ?? '', false);
        },
        parse: {}, // reading stays with markdown-it (same shape as the default spec)
      },
    };
  },
});

const PlainHardBreak = HardBreak.extend({
  addStorage() {
    return {
      markdown: {
        // Library default writes "\\\n" (CommonMark hard break). Plain "\n"
        // keeps the wire clean; Markdown.configure({ breaks: true }) maps it
        // back to a hardBreak on parse. The sibling loop mirrors the upstream
        // serializer: breaks trailing at the end of a block emit nothing, so a
        // dangling Shift+Enter never leaves a phantom blank line.
        serialize(state: MarkdownSerializeState, node: PMNode, parent: PMNode, index: number) {
          for (let i = index + 1; i < parent.childCount; i++) {
            if (parent.child(i).type !== node.type) {
              state.write('\n');
              return;
            }
          }
        },
        parse: {},
      },
    };
  },
});

/**
 * The full composer extension set — exported so the round-trip unit tests
 * (tests/unit/wysiwyg-roundtrip.test.ts) exercise the exact configuration that
 * ships, instead of maintaining a copy that can silently drift.
 */
export function composerExtensions(placeholder?: string | (() => string)) {
  return [
    // StarterKit's Link is replaced by an explicitly non-autolinking Link.
    // This preserves named attachment references in the controlled markdown
    // mirror without rewriting ordinary URLs as [url](url).
    // text/hardBreak:false — replaced by PlainText/PlainHardBreak (clean-wire
    // serialization, see above) which inherit the originals' full behaviour.
    StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: false, text: false, hardBreak: false }),
    Link.configure({
      autolink: false,
      linkOnPaste: false,
      openOnClick: false,
      protocols: ['attachment'],
    }),
    PlainText,
    PlainHardBreak,
    Placeholder.configure({
      placeholder: typeof placeholder === 'function' ? () => placeholder() : (placeholder ?? 'Message…'),
    }),
    Markdown.configure({
      html: false,
      bulletListMarker: '-',
      linkify: false,
      // breaks:true — the parse direction (draft restore, load-last, send-clear
      // pushback via setContent) maps a single \n back to a hardBreak instead of
      // joining lines with spaces. Pairs with PlainHardBreak serializing "\n".
      breaks: true,
      transformPastedText: false,
      transformCopiedText: false,
    }),
  ];
}

export interface RichComposerProps {
  /** Canonical markdown (controlled mirror — owned by the parent). */
  value: string;
  /** Fires on every editor change with the serialized markdown. */
  onChange: (markdown: string) => void;
  /** Native keydown from ProseMirror — return value of preventDefault decides consumption. */
  onKeyDown?: (e: KeyboardEvent) => void;
  /** Native paste from ProseMirror. */
  onPaste?: (e: ClipboardEvent) => void;
  /** Handed the editor instance once ready (for the toolbar + imperative focus). */
  onEditorReady?: (editor: Editor) => void;
  placeholder?: string;
  isMobile?: boolean;
  className?: string;
  ariaLabel?: string;
}

/**
 * WYSIWYG composer built on TipTap v3. Formatting (H2, bullets, inline/code-block)
 * renders live in the box; on every change it serializes to clean markdown so the
 * rest of the composer (send, draft, autocomplete detection, structured preview)
 * keeps reading a plain markdown string. Markdown is the source of truth; the editor
 * is a controlled view synced one-way (editor -> value) during typing, and pushed
 * back (value -> editor) only on external changes (draft restore, autocomplete
 * insert, send-clear, load-last) via the divergence guard.
 */
export function RichComposer({
  value,
  onChange,
  onKeyDown,
  onPaste,
  onEditorReady,
  placeholder,
  isMobile,
  className,
  ariaLabel,
}: RichComposerProps) {
  // Latest-handler refs — useEditor memoizes editorProps once, so reading through
  // refs keeps the captured handlers (and the markdown they close over) fresh.
  const onChangeRef = React.useRef(onChange);
  onChangeRef.current = onChange;
  const onKeyDownRef = React.useRef(onKeyDown);
  onKeyDownRef.current = onKeyDown;
  const onPasteRef = React.useRef(onPaste);
  onPasteRef.current = onPaste;

  // useEditor builds extensions once, so a static placeholder froze on the first
  // channel ("Message #Costa Vida..." shown in another channel). Read it live.
  const placeholderRef = React.useRef(placeholder);
  placeholderRef.current = placeholder;

  // Markdown the editor last emitted — distinguishes our own echo from an external set.
  const lastEmittedRef = React.useRef<string>(value);
  const reportedRef = React.useRef<Editor | null>(null);

  const editor = useEditor({
    immediatelyRender: false, // Next.js SSR: avoid hydration mismatch
    extensions: composerExtensions(() => placeholderRef.current ?? 'Message…'),
    content: value,
    editorProps: {
      attributes: {
        class: 'collab-rich-editor',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': ariaLabel ?? 'Message composer',
      },
      handleKeyDown: (_view, event) => {
        onKeyDownRef.current?.(event);
        // If the parent called preventDefault (send / autocomplete nav), we consumed it.
        return event.defaultPrevented;
      },
      handlePaste: (_view, event) => {
        onPasteRef.current?.(event as ClipboardEvent);
        return (event as ClipboardEvent).defaultPrevented;
      },
    },
    onUpdate: ({ editor }) => {
      // Strip the serializer's trailing newline so the canonical mirror is clean —
      // the end-anchored autocomplete regexes (/@(\w*)$/ etc.) depend on it, and
      // lastEmittedRef must match exactly what the parent stores or the echo-guard
      // below would re-setContent on every keystroke (cursor jump).
      const md = getMarkdown(editor).replace(/\n+$/, '');
      lastEmittedRef.current = md;
      onChangeRef.current?.(md);
    },
  });

  // Placeholder decorations only recompute on a state update; nudge one when the
  // text changes (e.g. switching channel) so the new name shows immediately.
  React.useEffect(() => {
    if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta('addToHistory', false));
  }, [editor, placeholder]);

  // External -> editor sync (guarded against echoing our own emits).
  React.useEffect(() => {
    if (!editor) return;
    if (value === lastEmittedRef.current) return;
    lastEmittedRef.current = value;
    editor.commands.setContent(value, { emitUpdate: false });
    // focus('end') is ProseMirror-aware: it focuses the DOM AND places the cursor
    // at the end of the new content. setTextSelection alone doesn't focus, so a
    // subsequent raw .focus() call (from click handlers in ColabChatView) refocuses
    // from an unfocused state and browsers reset cursor to position 0, putting it
    // before any prepended @mention text.
    editor.commands.focus('end');
    // tiptap-markdown's block-level parse (unlike its inline insertContentAt path)
    // has no whitespace-preservation special case, and CommonMark itself has no
    // semantic meaning for a lone trailing space — markdown-it trims it. A mention
    // insert like "@Daniel " (roster click, reply-to-avatar, autocomplete pick)
    // loses its trailing space here, so the next keystroke runs straight into the
    // name. Top it up as a raw text insert at the cursor (now valid post-focus),
    // bypassing the markdown parser entirely so the space can't be trimmed again.
    const trailingSpace = value.match(/[ \t]+$/)?.[0];
    if (trailingSpace && !editor.getText().endsWith(trailingSpace)) {
      editor.view.dispatch(editor.state.tr.insertText(trailingSpace));
    }
  }, [value, editor]);

  // Report the instance once (per editor), for the toolbar + focus calls.
  React.useEffect(() => {
    if (editor && reportedRef.current !== editor) {
      reportedRef.current = editor;
      onEditorReady?.(editor);
    }
  }, [editor, onEditorReady]);

  return <EditorContent editor={editor} className={className} data-mobile={isMobile ? 'true' : undefined} />;
}
