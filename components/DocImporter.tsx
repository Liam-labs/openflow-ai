'use client';

import { useState, useRef, useCallback } from 'react';
import {
  Upload,
  FileText,
  FolderOpen,
  X,
  Check,
  AlertCircle,
  Loader2,
  Tag,
  Plus,
} from 'lucide-react';

interface DocImporterProps {
  onImport: (doc: {
    title: string;
    category: 'snippets' | 'guides';
    tags: string[];
    content: string;
    sourcePath?: string;
  }) => Promise<void>;
  onCancel: () => void;
}

interface ImportedFile {
  name: string;
  content: string;
  path?: string;
}

export function DocImporter({ onImport, onCancel }: DocImporterProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [importedFile, setImportedFile] = useState<ImportedFile | null>(null);
  const [filePath, setFilePath] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState<'snippets' | 'guides'>('snippets');
  const [title, setTitle] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const processFile = async (file: File) => {
    setIsLoading(true);
    setError(null);

    try {
      // Check file type
      const validTypes = ['.md', '.txt', '.markdown'];
      const extension = '.' + file.name.split('.').pop()?.toLowerCase();

      if (!validTypes.includes(extension)) {
        throw new Error('Please drop a markdown (.md) or text (.txt) file');
      }

      const content = await file.text();
      const nameWithoutExt = file.name.replace(/\.(md|txt|markdown)$/i, '');

      setImportedFile({
        name: file.name,
        content,
      });
      setTitle(nameWithoutExt.replace(/-/g, ' ').replace(/_/g, ' '));

      // Try to extract tags from content
      const tagMatches = content.match(/tags:\s*\[(.*?)\]/);
      if (tagMatches) {
        const extractedTags = tagMatches[1]
          .split(',')
          .map(t => t.trim().replace(/['"]/g, ''))
          .filter(Boolean);
        setTags(extractedTags);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to read file');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      await processFile(files[0]);
    }
  }, []);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      await processFile(files[0]);
    }
  };

  const handlePathImport = async () => {
    if (!filePath.trim()) {
      setError('Please enter a file path');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/docs/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to import file');
      }

      setImportedFile({
        name: data.filename,
        content: data.content,
        path: filePath,
      });
      setTitle(data.title || data.filename.replace(/\.(md|txt|markdown)$/i, ''));
      if (data.tags) {
        setTags(data.tags);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to import file');
    } finally {
      setIsLoading(false);
    }
  };

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

  const handleTagKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag();
    }
  };

  const handleSave = async () => {
    if (!importedFile) return;
    if (!title.trim()) {
      setError('Please enter a title');
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      await onImport({
        title,
        category,
        tags,
        content: importedFile.content,
        sourcePath: importedFile.path,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save document');
      setIsSaving(false);
    }
  };

  const resetImport = () => {
    setImportedFile(null);
    setTitle('');
    setTags([]);
    setError(null);
    setFilePath('');
  };

  return (
    <div className="glass-card p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Import Document</h2>
        <button
          onClick={onCancel}
          className="p-2 rounded-lg hover:bg-white/10 transition-colors"
          aria-label="Cancel import"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {!importedFile ? (
        <>
          {/* Drop Zone */}
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`
              border-2 border-dashed rounded-xl p-8 text-center cursor-pointer
              transition-all duration-200
              ${isDragOver
                ? 'border-accent bg-accent/10'
                : 'border-white/20 hover:border-white/40 hover:bg-white/5'
              }
            `}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".md,.txt,.markdown"
              onChange={handleFileSelect}
              className="hidden"
            />
            <Upload className={`w-12 h-12 mx-auto mb-4 ${isDragOver ? 'text-accent' : 'text-white/40'}`} />
            <p className="text-lg mb-2">
              {isDragOver ? 'Drop file here' : 'Drag & drop a file'}
            </p>
            <p className="text-sm text-muted">
              or click to browse (.md, .txt files)
            </p>
          </div>

          {/* Divider */}
          <div className="flex items-center gap-4">
            <div className="flex-1 h-px bg-white/10" />
            <span className="text-sm text-muted">or</span>
            <div className="flex-1 h-px bg-white/10" />
          </div>

          {/* File Path Input */}
          <div>
            <label className="block text-sm text-muted mb-2">
              Import from file path
            </label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <FolderOpen className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted" />
                <input
                  type="text"
                  value={filePath}
                  onChange={(e) => setFilePath(e.target.value)}
                  placeholder="/path/to/document.md"
                  className="w-full pl-11 pr-4 py-2.5 bg-black/40 border border-white/10 rounded-lg
                           text-white placeholder-white/40 focus:outline-none focus:border-accent/50
                           font-mono text-sm"
                  onKeyDown={(e) => e.key === 'Enter' && handlePathImport()}
                />
              </div>
              <button
                onClick={handlePathImport}
                disabled={isLoading || !filePath.trim()}
                className="px-4 py-2 rounded-lg bg-accent hover:bg-accent/80 transition-colors
                         disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoading ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  'Import'
                )}
              </button>
            </div>
          </div>
        </>
      ) : (
        <>
          {/* Imported File Preview */}
          <div className="p-4 bg-success/10 border border-success/20 rounded-lg">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-success/20">
                <FileText className="w-5 h-5 text-success" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate">{importedFile.name}</p>
                <p className="text-sm text-muted">
                  {importedFile.content.length} characters
                </p>
              </div>
              <button
                onClick={resetImport}
                className="p-2 rounded-lg hover:bg-white/10 transition-colors"
                aria-label="Remove file"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Title */}
          <div>
            <label htmlFor="doc-import-title" className="block text-sm text-muted mb-1">Title</label>
            <input
              id="doc-import-title"
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
            <label className="block text-sm text-muted mb-1">Save as</label>
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
                onKeyDown={handleTagKeyDown}
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

          {/* Content Preview */}
          <div>
            <label className="block text-sm text-muted mb-1">Content Preview</label>
            <pre className="p-4 bg-black/40 rounded-lg border border-white/10 text-sm
                          font-mono overflow-x-auto max-h-[200px] overflow-y-auto text-white/70">
              {importedFile.content.slice(0, 500)}
              {importedFile.content.length > 500 && '\n...'}
            </pre>
          </div>
        </>
      )}

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 p-3 bg-error/10 border border-error/20 rounded-lg text-error">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <p className="text-sm">{error}</p>
        </div>
      )}

      {/* Actions */}
      {importedFile && (
        <div className="flex items-center justify-end gap-3 pt-4 border-t border-white/10">
          <button
            onClick={resetImport}
            className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20 transition-colors"
          >
            Import Different File
          </button>
          <button
            onClick={handleSave}
            disabled={isSaving || !title.trim()}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent hover:bg-accent/80
                     transition-colors disabled:opacity-50"
          >
            <Check className="w-4 h-4" />
            {isSaving ? 'Saving...' : 'Save to Docs'}
          </button>
        </div>
      )}
    </div>
  );
}
