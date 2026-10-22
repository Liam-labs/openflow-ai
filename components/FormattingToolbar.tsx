'use client';
import React from 'react';
import { Heading2, List, ListOrdered, Code, SquareCode } from 'lucide-react';
import { type Editor, useEditorState } from '@tiptap/react';

interface FormattingToolbarProps {
  editor: Editor | null;
  isMobile: boolean;
  extraChildren?: React.ReactNode;
}

/**
 * Live-formatting affordances for the WYSIWYG composer. Each button TOGGLES a
 * real TipTap mark/node (visible in the box) and reflects its active state, so
 * what the owner sees is what gets sent. onMouseDown is prevented so clicking a button
 * keeps the editor selection intact.
 */
export function FormattingToolbar({ editor, isMobile, extraChildren }: FormattingToolbarProps) {
  const state = useEditorState({
    editor,
    selector: ({ editor }) => ({
      bold: !!editor?.isActive('bold'),
      italic: !!editor?.isActive('italic'),
      heading: !!editor?.isActive('heading', { level: 2 }),
      bullet: !!editor?.isActive('bulletList'),
      ordered: !!editor?.isActive('orderedList'),
      code: !!editor?.isActive('code'),
      codeBlock: !!editor?.isActive('codeBlock'),
    }),
  }) ?? { bold: false, italic: false, heading: false, bullet: false, ordered: false, code: false, codeBlock: false };

  const buttons: { key: string; icon: React.ElementType; label: string; active: boolean; run: () => void }[] = [
    {
      key: 'heading',
      icon: Heading2,
      label: 'Heading',
      active: state.heading,
      run: () => editor?.chain().focus().toggleHeading({ level: 2 }).run(),
    },
    {
      key: 'bullet',
      icon: List,
      label: 'Bullet list',
      active: state.bullet,
      run: () => editor?.chain().focus().toggleBulletList().run(),
    },
    {
      key: 'ordered',
      icon: ListOrdered,
      label: 'Numbered list',
      active: state.ordered,
      run: () => editor?.chain().focus().toggleOrderedList().run(),
    },
    {
      key: 'inline-code',
      icon: Code,
      label: 'Inline code',
      active: state.code,
      run: () => editor?.chain().focus().toggleCode().run(),
    },
    {
      key: 'code-block',
      icon: SquareCode,
      label: 'Code block',
      active: state.codeBlock,
      run: () => editor?.chain().focus().toggleCodeBlock().run(),
    },
  ];

  return (
    <div className="collab-format-toolbar flex items-center gap-0.5 flex-wrap" role="toolbar" aria-label="Text formatting">
      {buttons.map(({ key, icon: Icon, label, active, run }) => (
        <button
          key={key}
          type="button"
          disabled={!editor}
          onMouseDown={(e) => e.preventDefault()}
          onClick={run}
          aria-pressed={active}
          className={`collab-format-btn flex items-center justify-center rounded-md transition-colors disabled:opacity-40 ${
            isMobile ? 'w-9 h-9' : 'w-7 h-7'
          } ${
            active
              ? 'text-blue-400 bg-blue-500/15'
              : 'text-muted hover:text-blue-400 hover:bg-white/[0.08] active:bg-white/[0.04]'
          }`}
          title={label}
          aria-label={label}
        >
          <Icon className={isMobile ? 'w-4 h-4' : 'w-3.5 h-3.5'} />
        </button>
      ))}
      {extraChildren}
    </div>
  );
}
