'use client';

import { useState, useRef, useCallback } from 'react';
import {
  Bold,
  Italic,
  Code,
  List,
  ListOrdered,
  Heading1,
  Heading2,
  Heading3,
  Link,
  Quote,
  FileCode,
  Eye,
  Edit3,
  Save,
  X,
  Tag,
  Plus,
} from 'lucide-react';

interface DocEditorProps {
  onSave: (doc: {
    title: string;
    category: 'snippets' | 'guides';
    tags: string[];
    content: string;
  }) => Promise<void>;
  onCancel: () => void;
  initialData?: {
    title: string;
    category: 'snippets' | 'guides';
    tags: string[];
    content: string;
  };
}

export function DocEditor({ onSave, onCancel, initialData }: DocEditorProps) {
  const [title, setTitle] = useState(initialData?.title || '');
  const [category, setCategory] = useState<'snippets' | 'guides'>(
    initialData?.category || 'snippets'
  );
  const [tags, setTags] = useState<string[]>(initialData?.tags || []);
  const [tagInput, setTagInput] = useState('');
  const [content, setContent] = useState(initialData?.content || '');
  const [isPreview, setIsPreview] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const insertMarkdown = useCallback((before: string, after: string = '', placeholder: string = '') => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selectedText = content.substring(start, end) || placeholder;

    const newContent =
      content.substring(0, start) +
      before +
      selectedText +
      after +
      content.substring(end);

    setContent(newContent);

    // Restore cursor position
    setTimeout(() => {
      textarea.focus();
      const newCursorPos = start + before.length + selectedText.length;
      textarea.setSelectionRange(newCursorPos, newCursorPos);
    }, 0);
  }, [content]);

  const toolbarActions = [
    { icon: Bold, action: () => insertMarkdown('**', '**', 'bold text'), title: 'Bold' },
    { icon: Italic, action: () => insertMarkdown('*', '*', 'italic text'), title: 'Italic' },
    { icon: Code, action: () => insertMarkdown('`', '`', 'code'), title: 'Inline Code' },
    { icon: FileCode, action: () => insertMarkdown('\n```\n', '\n```\n', 'code block'), title: 'Code Block' },
    { type: 'separator' },
    { icon: Heading1, action: () => insertMarkdown('\n# ', '\n', 'Heading 1'), title: 'Heading 1' },
    { icon: Heading2, action: () => insertMarkdown('\n## ', '\n', 'Heading 2'), title: 'Heading 2' },
    { icon: Heading3, action: () => insertMarkdown('\n### ', '\n', 'Heading 3'), title: 'Heading 3' },
    { type: 'separator' },
    { icon: List, action: () => insertMarkdown('\n- ', '\n', 'list item'), title: 'Bullet List' },
    { icon: ListOrdered, action: () => insertMarkdown('\n1. ', '\n', 'list item'), title: 'Numbered List' },
    { icon: Quote, action: () => insertMarkdown('\n> ', '\n', 'quote'), title: 'Quote' },
    { icon: Link, action: () => insertMarkdown('[', '](url)', 'link text'), title: 'Link' },
  ];

  const addTag = () => {
    const tag = tagInput.trim().toLowerCase();
    if (tag && !tags.includes(tag)) {
      setTags([...tags, tag]);
    }
    setTagInput('');
  };

  const removeTag = (tagToRemove: string) => {
    setTags(tags.filter(t => t !== tagToRemove));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag();
    }
  };

  const handleSave = async () => {
    if (!title.trim()) {
      alert('Please enter a title');
      return;
    }
    if (!content.trim()) {
      alert('Please enter some content');
      return;
    }

    setIsSaving(true);
    try {
      await onSave({ title, category, tags, content });
    } catch (error) {
      console.error('Failed to save:', error);
      alert('Failed to save document');
    } finally {
      setIsSaving(false);
    }
  };

  // Simple markdown to HTML conversion for preview
  const renderPreview = (markdown: string) => {
    let html = markdown
      // Code blocks first
      .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="bg-black/40 p-3 rounded-lg overflow-x-auto my-2"><code>$2</code></pre>')
      // Headings
      .replace(/^### (.*$)/gim, '<h3 class="text-lg font-semibold mt-4 mb-2">$1</h3>')
      .replace(/^## (.*$)/gim, '<h2 class="text-xl font-semibold mt-4 mb-2">$1</h2>')
      .replace(/^# (.*$)/gim, '<h1 class="text-2xl font-bold mt-4 mb-2">$1</h1>')
      // Bold and italic
      .replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      // Inline code
      .replace(/`([^`]+)`/g, '<code class="bg-black/30 px-1 rounded text-accent">$1</code>')
      // Links
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="text-accent hover:underline">$1</a>')
      // Lists
      .replace(/^\- (.*$)/gim, '<li class="ml-4">$1</li>')
      .replace(/^\d+\. (.*$)/gim, '<li class="ml-4 list-decimal">$1</li>')
      // Blockquotes
      .replace(/^> (.*$)/gim, '<blockquote class="border-l-2 border-accent/50 pl-4 italic text-muted">$1</blockquote>')
      // Line breaks
      .replace(/\n/g, '<br />');

    return html;
  };

  return (
    <div className="glass-card p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">
          {initialData ? 'Edit Document' : 'Create New Document'}
        </h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsPreview(!isPreview)}
            className={`p-2 rounded-lg transition-colors ${
              isPreview ? 'bg-accent text-white' : 'bg-white/10 hover:bg-white/20'
            }`}
            title={isPreview ? 'Edit' : 'Preview'}
          >
            {isPreview ? <Edit3 className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Title */}
      <div>
        <label className="block text-sm text-muted mb-1">Title</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Document title..."
          className="w-full px-4 py-2 bg-black/40 border border-white/10 rounded-lg
                   text-white placeholder-white/40 focus:outline-none focus:border-accent/50"
        />
      </div>

      {/* Category */}
      <div>
        <label className="block text-sm text-muted mb-1">Category</label>
        <div className="flex gap-2">
          <button
            onClick={() => setCategory('snippets')}
            className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium transition-all ${
              category === 'snippets'
                ? 'bg-accent text-white'
                : 'bg-white/10 hover:bg-white/20'
            }`}
          >
            Snippet
          </button>
          <button
            onClick={() => setCategory('guides')}
            className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium transition-all ${
              category === 'guides'
                ? 'bg-accent text-white'
                : 'bg-white/10 hover:bg-white/20'
            }`}
          >
            Guide
          </button>
        </div>
      </div>

      {/* Tags */}
      <div>
        <label className="block text-sm text-muted mb-1">Tags</label>
        <div className="flex flex-wrap gap-2 mb-2">
          {tags.map((tag) => (
            <span
              key={tag}
              className="flex items-center gap-1 px-2 py-1 rounded-full bg-accent/20 text-accent text-sm"
            >
              <Tag className="w-3 h-3" />
              {tag}
              <button
                onClick={() => removeTag(tag)}
                className="ml-1 hover:text-white"
              >
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Add tag and press Enter..."
            className="flex-1 px-4 py-2 bg-black/40 border border-white/10 rounded-lg
                     text-white placeholder-white/40 focus:outline-none focus:border-accent/50 text-sm"
          />
          <button
            onClick={addTag}
            className="p-2 rounded-lg bg-white/10 hover:bg-white/20 transition-colors"
            aria-label="Add tag"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Toolbar */}
      {!isPreview && (
        <div className="flex flex-wrap items-center gap-1 p-2 bg-black/30 rounded-lg border border-white/5">
          {toolbarActions.map((item, index) => {
            if (item.type === 'separator') {
              return <div key={index} className="w-px h-6 bg-white/10 mx-1" />;
            }
            const Icon = item.icon!;
            return (
              <button
                key={index}
                onClick={item.action}
                className="p-2 rounded hover:bg-white/10 transition-colors"
                title={item.title}
              >
                <Icon className="w-4 h-4" />
              </button>
            );
          })}
        </div>
      )}

      {/* Editor / Preview */}
      <div className="min-h-[300px]">
        {isPreview ? (
          <div
            className="prose prose-invert prose-sm max-w-none p-4 bg-black/20 rounded-lg border border-white/5 min-h-[300px]"
            dangerouslySetInnerHTML={{ __html: renderPreview(content) }}
          />
        ) : (
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Write your markdown content here..."
            className="w-full h-[300px] px-4 py-3 bg-black/40 border border-white/10 rounded-lg
                     text-white placeholder-white/40 focus:outline-none focus:border-accent/50
                     font-mono text-sm resize-y"
          />
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-3 pt-4 border-t border-white/10">
        <button
          onClick={onCancel}
          className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={isSaving}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent hover:bg-accent/80
                   transition-colors disabled:opacity-50"
        >
          <Save className="w-4 h-4" />
          {isSaving ? 'Saving...' : 'Save Document'}
        </button>
      </div>
    </div>
  );
}
