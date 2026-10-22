'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Search,
  FileText,
  BookOpen,
  Tag,
  X,
  ChevronRight,
  Code,
  Loader2,
  Plus,
  Upload,
  Trash2,
  MessageSquare,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { DocSearchResult } from '@/lib/types';
import { DocEditor } from './DocEditor';
import { DocImporter } from './DocImporter';
import { useChatPanel } from '@/lib/contexts/ChatContext';

type ViewMode = 'list' | 'create' | 'import';

interface DocsPanelProps {
  onDocsCountChange?: (count: number) => void;
}

export function DocsPanel({ onDocsCountChange }: DocsPanelProps) {
  const { openSession, hasActiveSession, isPanelOpen, openPanel } = useChatPanel();
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [searchQuery, setSearchQuery] = useState('');
  const [results, setResults] = useState<DocSearchResult[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<{
    id: string;
    title: string;
    content: string;
    category: string;
    tags: string[];
  } | null>(null);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSearching, setIsSearching] = useState(false);
  const [isDeleting, setIsDeleting] = useState<string | null>(null);

  // Fetch all docs on mount
  const fetchDocs = useCallback(async () => {
    try {
      const response = await fetch('/api/docs');
      const data = await response.json();
      setResults(data.results || []);
      onDocsCountChange?.(data.results?.length || 0);

      // Fetch tags
      const tagsResponse = await fetch('/api/docs?tags=true');
      const tagsData = await tagsResponse.json();
      setAllTags(tagsData.tags || []);
    } catch (error) {
      console.error('Failed to fetch docs:', error);
    } finally {
      setIsLoading(false);
    }
  }, [onDocsCountChange]);

  useEffect(() => {
    fetchDocs();
  }, [fetchDocs]);

  // Search with debounce
  useEffect(() => {
    const timer = setTimeout(async () => {
      if (!searchQuery && !selectedTag) {
        fetchDocs();
        return;
      }

      setIsSearching(true);
      try {
        const query = selectedTag
          ? `${searchQuery} ${selectedTag}`.trim()
          : searchQuery;
        const response = await fetch(`/api/docs?q=${encodeURIComponent(query)}`);
        const data = await response.json();
        setResults(data.results || []);
      } catch (error) {
        console.error('Search failed:', error);
      } finally {
        setIsSearching(false);
      }
    }, 150); // Fast debounce for instant feel

    return () => clearTimeout(timer);
  }, [searchQuery, selectedTag, fetchDocs]);

  // Fetch full doc content when selected
  const handleSelectDoc = async (docId: string) => {
    try {
      const response = await fetch(`/api/docs?id=${encodeURIComponent(docId)}`);
      const data = await response.json();
      if (data.doc) {
        setSelectedDoc(data.doc);
      }
    } catch (error) {
      console.error('Failed to fetch doc:', error);
    }
  };

  const handleTagClick = (tag: string) => {
    setSelectedTag(selectedTag === tag ? null : tag);
  };

  const handleClearSearch = () => {
    setSearchQuery('');
    setSelectedTag(null);
  };

  // Save a new document
  const handleSaveDoc = async (doc: {
    title: string;
    category: 'snippets' | 'guides';
    tags: string[];
    content: string;
  }) => {
    const response = await fetch('/api/docs', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(doc),
    });

    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || 'Failed to save document');
    }

    setViewMode('list');
    await fetchDocs();
  };

  // Import a document
  const handleImportDoc = async (doc: {
    title: string;
    category: 'snippets' | 'guides';
    tags: string[];
    content: string;
    sourcePath?: string;
  }) => {
    await handleSaveDoc(doc);
  };

  // Delete a document
  const handleDeleteDoc = async (docId: string) => {
    if (!confirm('Are you sure you want to delete this document?')) {
      return;
    }

    setIsDeleting(docId);
    try {
      const response = await fetch(`/api/docs?id=${encodeURIComponent(docId)}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to delete document');
      }

      setSelectedDoc(null);
      await fetchDocs();
    } catch (error) {
      console.error('Delete failed:', error);
      alert('Failed to delete document');
    } finally {
      setIsDeleting(null);
    }
  };

  // Filter results by selected tag
  const filteredResults = useMemo(() => {
    if (!selectedTag) return results;
    return results.filter(r => r.tags.includes(selectedTag));
  }, [results, selectedTag]);

  // Group results by category
  const groupedResults = useMemo(() => {
    const groups: Record<string, DocSearchResult[]> = {
      snippets: [],
      guides: [],
    };
    filteredResults.forEach(result => {
      if (groups[result.category]) {
        groups[result.category].push(result);
      }
    });
    return groups;
  }, [filteredResults]);

  if (isLoading) {
    return (
      <div className="space-y-6">
        {/* Search bar skeleton */}
        <div className="glass-card p-4">
          <div className="flex gap-3 mb-4">
            <div className="flex-1 h-[52px] rounded-xl skeleton" />
            <div className="w-[100px] h-[52px] rounded-xl skeleton" />
            <div className="w-[100px] h-[52px] rounded-xl skeleton" />
          </div>
          <div className="flex gap-2">
            <div className="w-16 h-6 rounded-full skeleton" />
            <div className="w-20 h-6 rounded-full skeleton" />
            <div className="w-14 h-6 rounded-full skeleton" />
          </div>
        </div>
        {/* Doc cards skeleton */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="glass-card p-4"
              style={{ animationDelay: `${i * 80}ms` }}
            >
              <div className="w-3/4 h-4 rounded skeleton mb-2" />
              <div className="w-full h-3 rounded skeleton mb-1" />
              <div className="w-2/3 h-3 rounded skeleton mb-3" />
              <div className="flex gap-1.5">
                <div className="w-12 h-5 rounded skeleton" />
                <div className="w-16 h-5 rounded skeleton" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Show editor view
  if (viewMode === 'create') {
    return (
      <DocEditor
        onSave={handleSaveDoc}
        onCancel={() => setViewMode('list')}
      />
    );
  }

  // Show importer view
  if (viewMode === 'import') {
    return (
      <DocImporter
        onImport={handleImportDoc}
        onCancel={() => setViewMode('list')}
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Search Bar with Actions */}
      <div className="glass-card p-4">
        <div className="flex gap-3 mb-4">
          <div className="relative flex-1">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search documentation..."
              className="w-full pl-12 pr-12 py-3 bg-black/40 border border-white/10 rounded-xl
                       text-white placeholder-white/40 focus:outline-none focus:border-accent/50
                       focus:ring-2 focus:ring-accent/20 transition-all text-lg"
              autoFocus
            />
            {(searchQuery || selectedTag) && (
              <button
                onClick={handleClearSearch}
                className="absolute right-4 top-1/2 -translate-y-1/2 p-1 rounded-lg
                         hover:bg-white/10 transition-colors"
                aria-label="Clear search"
              >
                <X className="w-5 h-5 text-muted" />
              </button>
            )}
            {isSearching && (
              <div className="absolute right-12 top-1/2 -translate-y-1/2">
                <Loader2 className="w-4 h-4 animate-spin text-accent" />
              </div>
            )}
          </div>

          {/* Action Buttons */}
          <button
            onClick={() => setViewMode('create')}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-accent hover:bg-accent/80
                     transition-colors font-medium"
            title="Create new document"
          >
            <Plus className="w-5 h-5" />
            <span className="hidden sm:inline">Create</span>
          </button>
          <button
            onClick={() => setViewMode('import')}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white/10 hover:bg-white/20
                     transition-colors font-medium"
            title="Import document"
          >
            <Upload className="w-5 h-5" />
            <span className="hidden sm:inline">Import</span>
          </button>
        </div>

        {/* Tags */}
        {allTags.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {allTags.slice(0, 15).map((tag) => (
              <button
                key={tag}
                onClick={() => handleTagClick(tag)}
                className={`
                  px-3 py-1 rounded-full text-xs font-medium transition-all
                  ${selectedTag === tag
                    ? 'bg-accent text-white'
                    : 'bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/80'
                  }
                `}
              >
                <span className="flex items-center gap-1">
                  <Tag className="w-3 h-3" />
                  {tag}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Selected Doc View */}
      {selectedDoc && (
        <div className="glass-card p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              {selectedDoc.category === 'snippets' ? (
                <Code className="w-5 h-5 text-accent" />
              ) : (
                <BookOpen className="w-5 h-5 text-accent" />
              )}
              <h2 className="text-xl font-semibold">{selectedDoc.title}</h2>
              {/* Active chat indicator */}
              {hasActiveSession(selectedDoc.id) && (
                <span className="flex items-center gap-1 text-xs text-green-400 bg-green-400/10 px-2 py-0.5 rounded">
                  <span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse" />
                  Chat Active
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {/* Chat button - opens global panel */}
              <button
                onClick={() => {
                  if (hasActiveSession(selectedDoc.id) && isPanelOpen) {
                    // Session exists and panel is open - already showing
                    return;
                  }
                  openSession('doc', selectedDoc.id, selectedDoc.title, selectedDoc.content);
                }}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-colors ${
                  hasActiveSession(selectedDoc.id)
                    ? 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
                    : 'bg-accent/20 text-accent hover:bg-accent/30'
                }`}
                title={hasActiveSession(selectedDoc.id) ? 'Open chat' : 'Ask Claude about this document'}
              >
                <MessageSquare className="w-4 h-4" />
                <span className="text-sm">{hasActiveSession(selectedDoc.id) ? 'Open Chat' : 'Ask Claude'}</span>
              </button>
              {/* Delete button */}
              <button
                onClick={() => handleDeleteDoc(selectedDoc.id)}
                disabled={isDeleting === selectedDoc.id}
                className="p-2 rounded-lg hover:bg-error/20 text-muted hover:text-error transition-colors
                         disabled:opacity-50"
                title="Delete document"
              >
                {isDeleting === selectedDoc.id ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <Trash2 className="w-5 h-5" />
                )}
              </button>
              {/* Close button */}
              <button
                onClick={() => setSelectedDoc(null)}
                className="p-2 rounded-lg hover:bg-white/10 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 mb-4">
            {selectedDoc.tags.map((tag) => (
              <span
                key={tag}
                className="px-2 py-0.5 rounded-full text-xs bg-accent/20 text-accent"
              >
                {tag}
              </span>
            ))}
          </div>

          <div className="markdown-content">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {selectedDoc.content}
            </ReactMarkdown>
          </div>
        </div>
      )}

      {/* Results */}
      {!selectedDoc && (
        <div className="space-y-6">
          {/* Snippets */}
          {groupedResults.snippets.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-white/60 mb-3 flex items-center gap-2">
                <Code className="w-4 h-4" />
                Snippets ({groupedResults.snippets.length})
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {groupedResults.snippets.map((result) => (
                  <DocResultCard
                    key={result.id}
                    result={result}
                    onClick={() => handleSelectDoc(result.id)}
                    searchQuery={searchQuery}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Guides */}
          {groupedResults.guides.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-white/60 mb-3 flex items-center gap-2">
                <BookOpen className="w-4 h-4" />
                Guides ({groupedResults.guides.length})
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {groupedResults.guides.map((result) => (
                  <DocResultCard
                    key={result.id}
                    result={result}
                    onClick={() => handleSelectDoc(result.id)}
                    searchQuery={searchQuery}
                  />
                ))}
              </div>
            </div>
          )}

          {/* No Results */}
          {filteredResults.length === 0 && (
            <div className="glass-card p-8 text-center">
              {searchQuery ? (
                <>
                  <FileText className="w-12 h-12 text-white/20 mx-auto mb-4" />
                  <p className="text-lg mb-2">No documents found</p>
                  <p className="text-sm text-muted">No results for &quot;{searchQuery}&quot;</p>
                </>
              ) : (
                <>
                  <BookOpen className="w-10 h-10 text-white/20 mx-auto mb-4" />
                  <p className="text-lg font-medium mb-2">Your knowledge base is empty</p>
                  <p className="text-sm text-white/50 mb-6 max-w-sm mx-auto">
                    Searchable documentation indexed for AI agents — drop in markdown files and they become instantly queryable.
                  </p>
                  <ul className="text-left inline-block space-y-2 text-sm text-white/40">
                    <li className="flex items-start gap-2">
                      <span className="text-white/20 mt-0.5">—</span>
                      <span>Add <code className="text-white/60 bg-white/5 px-1 rounded">.md</code> files to the <code className="text-white/60 bg-white/5 px-1 rounded">docs/</code> folder</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-white/20 mt-0.5">—</span>
                      <span>Content is auto-indexed for agent search within seconds</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="text-white/20 mt-0.5">—</span>
                      <span>Organize by topic subfolder for better discovery</span>
                    </li>
                  </ul>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Individual result card component
function DocResultCard({
  result,
  onClick,
  searchQuery,
}: {
  result: DocSearchResult;
  onClick: () => void;
  searchQuery: string;
}) {
  // Highlight matching text in excerpt
  const highlightedExcerpt = useMemo(() => {
    if (!searchQuery) return result.excerpt;

    const regex = new RegExp(`(${searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return result.excerpt.replace(regex, '<mark class="bg-accent/30 text-white rounded px-0.5">$1</mark>');
  }, [result.excerpt, searchQuery]);

  return (
    <button
      onClick={onClick}
      className="glass-card p-4 text-left hover:border-accent/30 transition-all group w-full"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <h4 className="font-medium mb-1 group-hover:text-accent transition-colors truncate">
            {result.title}
          </h4>
          <p
            className="text-sm text-muted line-clamp-2"
            dangerouslySetInnerHTML={{ __html: highlightedExcerpt }}
          />
        </div>
        <ChevronRight className="w-4 h-4 text-muted group-hover:text-accent transition-colors flex-shrink-0 mt-1" />
      </div>

      <div className="flex flex-wrap gap-1.5 mt-3">
        {result.tags.slice(0, 3).map((tag) => (
          <span
            key={tag}
            className="px-1.5 py-0.5 rounded text-xs bg-white/5 text-white/50"
          >
            {tag}
          </span>
        ))}
        {result.tags.length > 3 && (
          <span className="text-xs text-white/30">+{result.tags.length - 3}</span>
        )}
      </div>
    </button>
  );
}
