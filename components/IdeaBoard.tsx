'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Lightbulb,
  Plus,
  X,
  Image as ImageIcon,
  Tag,
  Pencil,
  Trash2,
  Search,
  Palette,
  Loader2,
  MessageSquare,
} from 'lucide-react';
import type { Idea } from '@/lib/types';

interface IdeaBoardProps {
  onIdeasCountChange?: (count: number) => void;
  onDiscuss?: (channelId: string) => void;
}

const COLORS = [
  '#8B5CF6', '#3B82F6', '#10B981', '#F59E0B',
  '#EF4444', '#EC4899', '#06B6D4', '#F97316',
];

export function IdeaBoard({ onIdeasCountChange, onDiscuss }: IdeaBoardProps) {
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterTag, setFilterTag] = useState<string | null>(null);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);

  // Create form
  const [newTitle, setNewTitle] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newTags, setNewTags] = useState<string[]>([]);
  const [newTagInput, setNewTagInput] = useState('');
  const [newColor, setNewColor] = useState(COLORS[0]);
  const [newImages, setNewImages] = useState<Array<{ data: string; name: string; type: string }>>([]);
  const [saving, setSaving] = useState(false);

  // Edit form
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editTags, setEditTags] = useState<string[]>([]);
  const [editTagInput, setEditTagInput] = useState('');
  const [editColor, setEditColor] = useState(COLORS[0]);

  const [linkingId, setLinkingId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchIdeas = useCallback(async () => {
    try {
      const res = await fetch('/api/ideas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list' }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          setIdeas(data.ideas || []);
        }
      }
    } catch {
      // API may not be ready yet
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchIdeas(); }, [fetchIdeas]);

  useEffect(() => {
    onIdeasCountChange?.(ideas.length);
  }, [ideas.length, onIdeasCountChange]);

  // Paste images when create modal is open
  useEffect(() => {
    if (!showCreate) return;
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (!file) continue;
          const reader = new FileReader();
          reader.onload = () => {
            setNewImages(prev => [...prev, {
              data: reader.result as string,
              name: file.name || 'pasted-image.png',
              type: file.type,
            }]);
          };
          reader.readAsDataURL(file);
        }
      }
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [showCreate]);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue;
      const reader = new FileReader();
      reader.onload = () => {
        setNewImages(prev => [...prev, {
          data: reader.result as string,
          name: file.name,
          type: file.type,
        }]);
      };
      reader.readAsDataURL(file);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleCreate = async () => {
    if (!newTitle.trim()) return;
    setSaving(true);

    try {
      // First create the idea
      const res = await fetch('/api/ideas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          title: newTitle.trim(),
          description: newDescription.trim(),
          tags: newTags,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.success && data.idea) {
          let idea = data.idea;

          // Upload images one at a time
          for (const img of newImages) {
            try {
              const imgRes = await fetch('/api/ideas', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  action: 'upload_image',
                  ideaId: idea.id,
                  image: { data: img.data, name: img.name, type: img.type },
                }),
              });
              if (imgRes.ok) {
                const imgData = await imgRes.json();
                if (imgData.idea) idea = imgData.idea;
              }
            } catch {
              // Image upload failed — continue with remaining
            }
          }

          setIdeas(prev => [idea, ...prev]);
        }
      }
    } catch {
      // API error
    } finally {
      setSaving(false);
      resetCreateForm();
    }
  };

  const handleUpdate = async (ideaId: string) => {
    const prev = ideas.find(i => i.id === ideaId);
    if (!prev) return;

    const updated = {
      ...prev,
      title: editTitle.trim() || prev.title,
      description: editDescription.trim(),
      tags: editTags,
      updatedAt: new Date().toISOString(),
    };

    // Optimistic
    setIdeas(prevIdeas => prevIdeas.map(i => i.id === ideaId ? updated : i));
    setEditingId(null);

    try {
      await fetch('/api/ideas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update',
          ideaId,
          title: updated.title,
          description: updated.description,
          tags: updated.tags,
        }),
      });
    } catch {
      // Keep optimistic update
    }
  };

  const handleDelete = async (ideaId: string) => {
    if (!confirm('Delete this idea?')) return;
    const previousIdeas = [...ideas];
    setIdeas(prev => prev.filter(i => i.id !== ideaId));
    if (expandedId === ideaId) setExpandedId(null);

    try {
      const res = await fetch('/api/ideas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', ideaId }),
      });
      if (!res.ok) setIdeas(previousIdeas);
    } catch {
      setIdeas(previousIdeas);
    }
  };

  const handleDiscuss = async (idea: Idea) => {
    if (linkingId) return;
    setLinkingId(idea.id);
    try {
      const res = await fetch('/api/ideas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'link_channel', ideaId: idea.id }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          const channelId = data.idea?.channelId || data.channelId;
          if (channelId) {
            // Update idea locally with the linked channel
            setIdeas(prev => prev.map(i => i.id === idea.id ? { ...i, channelId } : i));
            onDiscuss?.(channelId);
          }
        }
      }
    } catch {
      // Link failed silently
    } finally {
      setLinkingId(null);
    }
  };

  const resetCreateForm = () => {
    setShowCreate(false);
    setNewTitle('');
    setNewDescription('');
    setNewTags([]);
    setNewTagInput('');
    setNewColor(COLORS[0]);
    setNewImages([]);
  };

  const startEditing = (idea: Idea) => {
    setEditingId(idea.id);
    setEditTitle(idea.title);
    setEditDescription(idea.description);
    setEditTags([...idea.tags]);
    setEditTagInput('');
    setEditColor(COLORS[0]);
  };

  const addTag = (input: string, setter: (tags: string[]) => void, tags: string[], clearInput: (v: string) => void) => {
    const tag = input.trim().toLowerCase();
    if (tag && !tags.includes(tag)) {
      setter([...tags, tag]);
    }
    clearInput('');
  };

  const allTags = Array.from(new Set(ideas.flatMap(i => i.tags))).sort();

  const filtered = ideas.filter(idea => {
    if (idea.archived) return false;
    if (filterTag && !idea.tags.includes(filterTag)) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return idea.title.toLowerCase().includes(q) || idea.description.toLowerCase().includes(q);
    }
    return true;
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-purple-400" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-amber-500/10 border border-amber-500/20">
            <Lightbulb className="w-5 h-5 text-amber-400" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">Idea Board</h2>
            <p className="text-xs text-white/40">{ideas.length} idea{ideas.length !== 1 ? 's' : ''}</p>
          </div>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-gradient-to-r from-purple-500 to-blue-500 text-white text-sm font-medium hover:from-purple-600 hover:to-blue-600 transition-all shadow-lg shadow-purple-500/20"
        >
          <Plus className="w-4 h-4" />
          New Idea
        </button>
      </div>

      {/* Search & Filters */}
      {ideas.length > 0 && (
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-white/30" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search ideas..."
              className="w-full pl-9 pr-3 py-2 bg-white/[0.04] border border-white/10 rounded-xl text-sm placeholder:text-white/30 focus:outline-none focus:border-purple-500/40"
            />
          </div>
          {allTags.length > 0 && (
            <div className="flex items-center gap-1.5 overflow-x-auto">
              <button
                onClick={() => setFilterTag(null)}
                className={`px-2.5 py-1 rounded-full text-xs whitespace-nowrap transition-colors ${
                  !filterTag ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30' : 'bg-white/5 text-white/40 border border-white/5 hover:bg-white/10'
                }`}
              >
                All
              </button>
              {allTags.map(tag => (
                <button
                  key={tag}
                  onClick={() => setFilterTag(filterTag === tag ? null : tag)}
                  className={`px-2.5 py-1 rounded-full text-xs whitespace-nowrap transition-colors ${
                    filterTag === tag ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30' : 'bg-white/5 text-white/40 border border-white/5 hover:bg-white/10'
                  }`}
                >
                  {tag}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Create Modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-20 px-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={resetCreateForm} />
          <div className="relative w-full max-w-lg bg-[#0c1829] border border-white/10 rounded-2xl shadow-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between bg-gradient-to-r from-amber-500/5 to-purple-500/5">
              <div className="flex items-center gap-2">
                <Lightbulb className="w-4 h-4 text-amber-400" />
                <h3 className="font-semibold text-sm">New Idea</h3>
              </div>
              <button onClick={resetCreateForm} className="p-1 rounded-lg hover:bg-white/10 text-white/40" aria-label="Cancel">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <input
                type="text"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="What's your idea?"
                className="w-full px-3 py-2.5 bg-white/[0.04] border border-white/10 rounded-xl text-sm placeholder:text-white/30 focus:outline-none focus:border-purple-500/40"
                autoFocus
              />
              <textarea
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="Describe it..."
                rows={4}
                className="w-full px-3 py-2.5 bg-white/[0.04] border border-white/10 rounded-xl text-sm placeholder:text-white/30 focus:outline-none focus:border-purple-500/40 resize-none"
              />

              {/* Images */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <ImageIcon className="w-3.5 h-3.5 text-white/40" />
                  <span className="text-xs text-white/40">Images (Ctrl+V to paste)</span>
                  <button onClick={() => fileInputRef.current?.click()} className="ml-auto text-xs text-purple-400 hover:text-purple-300">
                    Upload
                  </button>
                  <input ref={fileInputRef} type="file" accept="image/*" multiple onChange={handleFileUpload} className="hidden" />
                </div>
                {newImages.length > 0 && (
                  <div className="flex gap-2 flex-wrap">
                    {newImages.map((img, i) => (
                      <div key={i} className="relative group w-20 h-20 rounded-lg overflow-hidden border border-white/10">
                        <img src={img.data} alt={img.name} className="w-full h-full object-cover" />
                        <button
                          onClick={() => setNewImages(prev => prev.filter((_, idx) => idx !== i))}
                          className="absolute top-0.5 right-0.5 p-0.5 rounded bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Tags */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <Tag className="w-3.5 h-3.5 text-white/40" />
                  <span className="text-xs text-white/40">Tags</span>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  {newTags.map(tag => (
                    <span key={tag} className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-300 text-xs border border-purple-500/20">
                      {tag}
                      <button onClick={() => setNewTags(prev => prev.filter(t => t !== tag))} className="hover:text-white" aria-label={`Remove tag ${tag}`}><X className="w-2.5 h-2.5" /></button>
                    </span>
                  ))}
                  <input
                    type="text"
                    value={newTagInput}
                    onChange={(e) => setNewTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ',') {
                        e.preventDefault();
                        addTag(newTagInput, setNewTags, newTags, setNewTagInput);
                      }
                    }}
                    placeholder="Add tag..."
                    className="flex-1 min-w-[80px] px-2 py-1 bg-transparent text-xs placeholder:text-white/20 focus:outline-none"
                  />
                </div>
              </div>

              {/* Color */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <Palette className="w-3.5 h-3.5 text-white/40" />
                  <span className="text-xs text-white/40">Accent color</span>
                </div>
                <div className="flex gap-2">
                  {COLORS.map(color => (
                    <button
                      key={color}
                      onClick={() => setNewColor(color)}
                      className={`w-7 h-7 rounded-full transition-all ${
                        newColor === color ? 'ring-2 ring-white ring-offset-2 ring-offset-[#0c1829] scale-110' : 'hover:scale-110'
                      }`}
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button onClick={resetCreateForm} className="px-4 py-2 rounded-xl text-sm text-white/40 hover:bg-white/5">Cancel</button>
                <button
                  onClick={handleCreate}
                  disabled={!newTitle.trim() || saving}
                  className="px-4 py-2 rounded-xl text-sm bg-gradient-to-r from-purple-500 to-blue-500 text-white font-medium disabled:opacity-50 hover:from-purple-600 hover:to-blue-600 transition-all"
                >
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Create Idea'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Empty State */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="p-4 rounded-2xl bg-amber-500/5 border border-amber-500/10 mb-4">
            <Lightbulb className="w-10 h-10 text-amber-400/40" />
          </div>
          <h3 className="text-lg font-medium text-white/60 mb-1">
            {ideas.length === 0 ? 'Capture your first idea' : 'No matching ideas'}
          </h3>
          <p className="text-sm text-white/30 max-w-sm">
            {ideas.length === 0
              ? 'Ideas are notes with images and tags that you can discuss with your AI agents.'
              : 'Try a different search or clear the filter.'}
          </p>
          {ideas.length === 0 && (
            <button
              onClick={() => setShowCreate(true)}
              className="mt-4 flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-500/10 text-amber-400 text-sm border border-amber-500/20 hover:bg-amber-500/15 transition-colors"
            >
              <Plus className="w-4 h-4" />
              New Idea
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map(idea => {
            const isExpanded = expandedId === idea.id;
            const isEditing = editingId === idea.id;

            return (
              <div
                key={idea.id}
                className={`group relative bg-white/[0.03] border border-white/10 rounded-xl overflow-hidden hover:border-white/20 transition-all cursor-pointer ${
                  isExpanded ? 'md:col-span-2 lg:col-span-2' : ''
                }`}
                onClick={() => { if (!isEditing) setExpandedId(isExpanded ? null : idea.id); }}
              >
                {/* Color accent */}
                <div className="h-1 w-full" style={{ backgroundColor: idea.archived ? '#555' : (COLORS.includes(idea.tags?.[0] || '') ? undefined : COLORS[idea.sortOrder % COLORS.length]) }} />

                <div className="p-4">
                  {/* Title row */}
                  <div className="flex items-start justify-between gap-2 mb-2">
                    {isEditing ? (
                      <input
                        type="text"
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        className="flex-1 px-2 py-1 bg-white/[0.06] border border-white/10 rounded-lg text-sm font-semibold focus:outline-none focus:border-purple-500/40"
                        autoFocus
                      />
                    ) : (
                      <h3 className="font-semibold text-sm leading-tight">{idea.title}</h3>
                    )}
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                      <button
                        onClick={(e) => { e.stopPropagation(); startEditing(idea); }}
                        className="p-1 rounded hover:bg-white/10 text-white/40 hover:text-white"
                        title="Edit"
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDelete(idea.id); }}
                        className="p-1 rounded hover:bg-red-500/10 text-white/40 hover:text-red-400"
                        title="Delete"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>

                  {/* Description */}
                  {isEditing ? (
                    <textarea
                      value={editDescription}
                      onChange={(e) => setEditDescription(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      rows={isExpanded ? 6 : 3}
                      className="w-full px-2 py-1 bg-white/[0.06] border border-white/10 rounded-lg text-xs text-white/60 focus:outline-none focus:border-purple-500/40 resize-none mb-2"
                    />
                  ) : idea.description ? (
                    <p className={`text-xs text-white/40 leading-relaxed mb-3 whitespace-pre-wrap ${isExpanded ? '' : 'line-clamp-3'}`}>
                      {idea.description}
                    </p>
                  ) : null}

                  {/* Images */}
                  {idea.images.length > 0 && (
                    <div className={`flex gap-2 mb-3 ${isExpanded ? 'flex-wrap' : 'overflow-hidden'}`}>
                      {(isExpanded ? idea.images : idea.images.slice(0, 3)).map((img) => (
                        <div
                          key={img.id}
                          className={`rounded-lg overflow-hidden border border-white/10 flex-shrink-0 cursor-pointer hover:border-white/20 transition-colors ${
                            isExpanded ? 'w-32 h-32' : 'w-16 h-16'
                          }`}
                          onClick={(e) => { e.stopPropagation(); setLightboxImage(img.url); }}
                        >
                          <img src={img.url} alt="" className="w-full h-full object-cover" />
                        </div>
                      ))}
                      {!isExpanded && idea.images.length > 3 && (
                        <div className="w-16 h-16 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-xs text-white/30">
                          +{idea.images.length - 3}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Tags */}
                  {isEditing ? (
                    <div className="flex items-center gap-1.5 flex-wrap mb-3" onClick={(e) => e.stopPropagation()}>
                      {editTags.map(tag => (
                        <span key={tag} className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-300 text-[10px] border border-purple-500/20">
                          {tag}
                          <button onClick={() => setEditTags(prev => prev.filter(t => t !== tag))} aria-label={`Remove tag ${tag}`}><X className="w-2 h-2" /></button>
                        </span>
                      ))}
                      <input
                        type="text"
                        value={editTagInput}
                        onChange={(e) => setEditTagInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ',') {
                            e.preventDefault();
                            addTag(editTagInput, setEditTags, editTags, setEditTagInput);
                          }
                        }}
                        placeholder="tag..."
                        className="flex-1 min-w-[60px] px-1 py-0.5 bg-transparent text-[10px] placeholder:text-white/20 focus:outline-none"
                      />
                    </div>
                  ) : idea.tags.length > 0 ? (
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {idea.tags.map(tag => (
                        <span key={tag} className="px-2 py-0.5 rounded-full text-[10px] bg-white/5 text-white/30 border border-white/5">
                          {tag}
                        </span>
                      ))}
                    </div>
                  ) : null}

                  {/* Edit actions */}
                  {isEditing && (
                    <div className="flex items-center justify-end gap-2 pt-3 border-t border-white/5 mt-3" onClick={(e) => e.stopPropagation()}>
                      <button onClick={() => setEditingId(null)} className="px-3 py-1 rounded-lg text-xs text-white/40 hover:bg-white/5">Cancel</button>
                      <button onClick={() => handleUpdate(idea.id)} className="px-3 py-1 rounded-lg text-xs bg-purple-500/20 text-purple-300 hover:bg-purple-500/30">Save</button>
                    </div>
                  )}

                  {/* Footer */}
                  {!isEditing && (
                    <div className="flex items-center justify-between mt-3 pt-2 border-t border-white/5">
                      <span className="text-[10px] text-white/20">
                        {new Date(idea.createdAt).toLocaleDateString()}
                      </span>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDiscuss(idea); }}
                        disabled={linkingId === idea.id}
                        className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] transition-colors ${
                          idea.channelId
                            ? 'bg-purple-500/10 text-purple-400 border border-purple-500/20 hover:bg-purple-500/20'
                            : 'bg-white/5 text-white/40 border border-white/5 hover:bg-white/10 hover:text-white/60'
                        }`}
                      >
                        {linkingId === idea.id ? (
                          <Loader2 className="w-2.5 h-2.5 animate-spin" />
                        ) : (
                          <MessageSquare className="w-2.5 h-2.5" />
                        )}
                        {idea.channelId ? 'Discuss' : 'Start Discussion'}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Image Lightbox */}
      {lightboxImage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm cursor-pointer"
          onClick={() => setLightboxImage(null)}
        >
          <img src={lightboxImage} alt="" className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl" />
          <button className="absolute top-4 right-4 p-2 rounded-full bg-black/50 text-white hover:bg-black/70" onClick={() => setLightboxImage(null)}>
            <X className="w-5 h-5" />
          </button>
        </div>
      )}
    </div>
  );
}
