'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Search, Plus, Pencil, ArrowLeft, Check,
  ChevronDown, Loader2, BookOpen,
} from 'lucide-react';

interface Tool {
  id: string;
  name: string;
  slug: string;
  description: string;
  category: 'infrastructure' | 'api' | 'design' | 'workflow' | 'platform' | 'media';
  tags: string[];
  guidePath: string;
  createdAt: string;
  updatedAt: string;
}

type FilterCategory = 'all' | Tool['category'];

const CATEGORY_CONFIG = {
  infrastructure: { label: 'Infrastructure', text: 'text-sky-400',     pill: 'bg-sky-400/15 text-sky-300 border-sky-400/40',     activePill: 'bg-sky-400/25 text-sky-200 border-sky-400/60'     },
  api:            { label: 'API',            text: 'text-violet-400',  pill: 'bg-violet-400/15 text-violet-300 border-violet-400/40', activePill: 'bg-violet-400/25 text-violet-200 border-violet-400/60' },
  design:         { label: 'Design',         text: 'text-pink-400',    pill: 'bg-pink-400/15 text-pink-300 border-pink-400/40',    activePill: 'bg-pink-400/25 text-pink-200 border-pink-400/60'    },
  workflow:       { label: 'Workflow',        text: 'text-amber-400',   pill: 'bg-amber-400/15 text-amber-300 border-amber-400/40',   activePill: 'bg-amber-400/25 text-amber-200 border-amber-400/60'   },
  platform:       { label: 'Platform',       text: 'text-indigo-400',  pill: 'bg-indigo-400/15 text-indigo-300 border-indigo-400/40', activePill: 'bg-indigo-400/25 text-indigo-200 border-indigo-400/60' },
  media:          { label: 'Media',          text: 'text-emerald-400', pill: 'bg-emerald-400/15 text-emerald-300 border-emerald-400/40', activePill: 'bg-emerald-400/25 text-emerald-200 border-emerald-400/60' },
} as const;

const CATEGORY_COLORS: Record<Tool['category'], string> = {
  infrastructure: '#38bdf8',
  api: '#a78bfa',
  design: '#f472b6',
  workflow: '#fbbf24',
  platform: '#818cf8',
  media: '#34d399',
};

export function ToolsPanel() {
  const [tools, setTools] = useState<Tool[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [activeFilter, setActiveFilter] = useState<FilterCategory>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState<Record<string, string>>({});
  const [previewLoading, setPreviewLoading] = useState<string | null>(null);

  // Editor state
  const [editId, setEditId] = useState<string | null>(null);
  const [editToolName, setEditToolName] = useState('');
  const [editToolCategory, setEditToolCategory] = useState<Tool['category']>('platform');
  const [editToolPath, setEditToolPath] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editLoading, setEditLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');

  // New tool form state
  const [showNewForm, setShowNewForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newCategory, setNewCategory] = useState<Tool['category'] | ''>('');
  const [newDescription, setNewDescription] = useState('');
  const [newTags, setNewTags] = useState('');
  const [catOpen, setCatOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const catDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/settings/tools')
      .then(r => r.json())
      .then(d => { if (d.success) setTools(d.tools ?? []); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Close category dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (catDropdownRef.current && !catDropdownRef.current.contains(e.target as Node)) {
        setCatOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const handleExpand = useCallback(async (tool: Tool) => {
    if (expandedId === tool.id) { setExpandedId(null); return; }
    setExpandedId(tool.id);
    if (previewContent[tool.id]) return;
    setPreviewLoading(tool.id);
    try {
      const res = await fetch(`/api/settings/tools/${tool.id}`);
      const d = await res.json();
      if (d.success && d.guideContent != null) {
        setPreviewContent(prev => ({ ...prev, [tool.id]: d.guideContent }));
      }
    } catch { /* non-fatal */ }
    finally { setPreviewLoading(null); }
  }, [expandedId, previewContent]);

  const openEditor = useCallback(async (tool: Tool) => {
    setEditId(tool.id);
    setEditToolName(tool.name);
    setEditToolCategory(tool.category);
    setEditToolPath(tool.guidePath);
    setEditContent('');
    setSaveMsg('');
    setEditLoading(true);
    try {
      const res = await fetch(`/api/settings/tools/${tool.id}`);
      const d = await res.json();
      if (d.success) setEditContent(d.guideContent ?? '');
    } catch { /* non-fatal */ }
    finally { setEditLoading(false); }
  }, []);

  const handleSave = useCallback(async () => {
    if (!editId) return;
    setSaving(true);
    setSaveMsg('');
    try {
      const res = await fetch(`/api/settings/tools/${editId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guideContent: editContent }),
      });
      const d = await res.json();
      if (d.success) {
        setSaveMsg('✓ Saved');
        setPreviewContent(prev => ({ ...prev, [editId]: editContent }));
      } else {
        setSaveMsg(`Error: ${d.error || 'Save failed'}`);
      }
    } catch { setSaveMsg('Error: network failure'); }
    finally { setSaving(false); }
  }, [editId, editContent]);

  const resetNewForm = () => {
    setNewName(''); setNewCategory(''); setNewDescription(''); setNewTags('');
  };

  const handleCreate = useCallback(async () => {
    if (!newName || !newCategory) return;
    setCreating(true);
    try {
      const res = await fetch('/api/settings/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName,
          category: newCategory,
          description: newDescription,
          tags: newTags.split(',').map(t => t.trim()).filter(Boolean),
        }),
      });
      const d = await res.json();
      if (d.success && d.tool) {
        setTools(prev => [...prev, d.tool]);
        setShowNewForm(false);
        resetNewForm();
      }
    } catch { /* non-fatal */ }
    finally { setCreating(false); }
  }, [newName, newCategory, newDescription, newTags]);

  // ── Editor view ──
  if (editId) {
    const catCfg = CATEGORY_CONFIG[editToolCategory];
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setEditId(null); setSaveMsg(''); }}
            className="p-1 rounded hover:bg-white/10 text-white/40 hover:text-white/70 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <span className="text-sm font-medium text-white/75 truncate flex-1">{editToolName}</span>
          <span className={`text-[9px] px-2 py-0.5 rounded-full border flex-shrink-0 ${catCfg.pill}`}>
            {catCfg.label}
          </span>
        </div>

        <p className="text-[10px] text-white/30 font-mono truncate">{editToolPath}</p>

        {editLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-white/30 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading...
          </div>
        ) : (
          <textarea
            value={editContent}
            onChange={e => setEditContent(e.target.value)}
            className="w-full h-64 px-3 py-2 bg-black/40 border border-white/10 rounded-lg text-xs text-white/80 font-mono resize-none focus:border-purple-500/50 focus:outline-none leading-relaxed"
            spellCheck={false}
            placeholder={`# ${editToolName}\n\nWrite the guide content here...`}
          />
        )}

        <div className="flex items-center justify-between">
          <span className="text-[11px]">
            {saveMsg && (
              <span className={saveMsg.startsWith('✓') ? 'text-green-400' : 'text-red-400'}>
                {saveMsg}
              </span>
            )}
          </span>
          <button
            onClick={handleSave}
            disabled={saving || editLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm bg-purple-500 hover:bg-purple-600 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    );
  }

  // ── Filtered tools ──
  const filtered = tools.filter(t => {
    const matchesCat = activeFilter === 'all' || t.category === activeFilter;
    const q = search.toLowerCase();
    const matchesSearch = !q
      || t.name.toLowerCase().includes(q)
      || t.description.toLowerCase().includes(q)
      || t.tags.some(tag => tag.toLowerCase().includes(q));
    return matchesCat && matchesSearch;
  });

  // ── List view ──
  return (
    <div>
      {/* Top bar */}
      <div className="flex items-center gap-2 mb-3">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/25 pointer-events-none" />
          <input
            type="text"
            placeholder="Search tools..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 bg-white/[0.08] border border-white/15 rounded-lg text-xs text-white/80 placeholder:text-white/50 focus:border-purple-500/40 focus:outline-none transition-colors"
          />
        </div>
        <button
          onClick={() => setShowNewForm(v => !v)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-purple-500/15 hover:bg-purple-500/25 text-purple-300 border border-purple-500/20 hover:border-purple-500/35 transition-colors flex-shrink-0"
        >
          <Plus className="w-3.5 h-3.5" />
          New Tool
        </button>
      </div>

      {/* Category filter pills */}
      <div className="flex flex-wrap gap-1.5 mb-4">
        {(['all', ...Object.keys(CATEGORY_CONFIG)] as FilterCategory[]).map(cat => {
          const isActive = activeFilter === cat;
          const cfg = cat !== 'all' ? CATEGORY_CONFIG[cat as Tool['category']] : null;
          return (
            <button
              key={cat}
              onClick={() => setActiveFilter(cat)}
              className={`px-2.5 py-1 rounded-full text-[10px] font-medium border transition-colors ${
                isActive
                  ? cat === 'all'
                    ? 'bg-white/10 text-white/90 border-white/20'
                    : cfg!.activePill
                  : 'bg-white/10 text-white/70 border-white/20 hover:text-white/90 hover:border-white/30'
              }`}
            >
              {cat === 'all' ? 'All' : cfg!.label}
            </button>
          );
        })}
      </div>

      {/* New tool form */}
      {showNewForm && (
        <div className="mb-4 p-3 rounded-lg bg-purple-500/[0.05] border border-purple-500/[0.15]">
          <p className="text-xs font-medium text-white/70 mb-3">New Tool</p>
          <div className="space-y-2">
            <input
              placeholder="Name (e.g. Netlify Deploy)"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              className="w-full px-3 py-1.5 bg-white/[0.08] border border-white/15 rounded-lg text-xs text-white/80 placeholder:text-white/50 focus:border-purple-500/40 focus:outline-none"
            />
            <div className="relative" ref={catDropdownRef}>
              <button
                type="button"
                onClick={() => setCatOpen(v => !v)}
                className="w-full flex items-center justify-between px-3 py-1.5 bg-white/[0.08] border border-white/15 rounded-lg text-xs hover:border-white/25 transition-colors"
              >
                <span className={newCategory ? CATEGORY_CONFIG[newCategory].text : 'text-white/50'}>
                  {newCategory ? CATEGORY_CONFIG[newCategory].label : 'Category'}
                </span>
                <ChevronDown className={`w-3 h-3 text-white/25 transition-transform ${catOpen ? 'rotate-180' : ''}`} />
              </button>
              {catOpen && (
                <div className="absolute z-10 top-full mt-1 w-full bg-[#18293f] border border-white/15 rounded-lg shadow-xl overflow-hidden">
                  {(Object.entries(CATEGORY_CONFIG) as [Tool['category'], typeof CATEGORY_CONFIG[Tool['category']]][]).map(([key, cfg]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => { setNewCategory(key); setCatOpen(false); }}
                      className={`w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-white/[0.05] transition-colors ${cfg.text}`}
                    >
                      <span
                        className="w-2 h-2 rounded-full flex-shrink-0 opacity-60"
                        style={{ backgroundColor: CATEGORY_COLORS[key] }}
                      />
                      {cfg.label}
                      {newCategory === key && <Check className="w-3 h-3 ml-auto" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <input
              placeholder="Description — one sentence"
              value={newDescription}
              onChange={e => setNewDescription(e.target.value)}
              className="w-full px-3 py-1.5 bg-white/[0.08] border border-white/15 rounded-lg text-xs text-white/80 placeholder:text-white/50 focus:border-purple-500/40 focus:outline-none"
            />
            <input
              placeholder="Tags — comma separated (e.g. netlify, hosting, dns)"
              value={newTags}
              onChange={e => setNewTags(e.target.value)}
              className="w-full px-3 py-1.5 bg-white/[0.08] border border-white/15 rounded-lg text-xs text-white/80 placeholder:text-white/50 focus:border-purple-500/40 focus:outline-none"
            />
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                onClick={() => { setShowNewForm(false); resetNewForm(); }}
                className="px-3 py-1.5 text-xs text-white/40 hover:text-white/70 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={!newName || !newCategory || creating}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-purple-500 hover:bg-purple-600 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {creating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                {creating ? 'Creating...' : 'Create Tool'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center gap-2 text-sm text-white/40 py-6 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading tools...
        </div>
      )}

      {/* Empty — no tools at all */}
      {!loading && tools.length === 0 && (
        <div className="text-center py-10">
          <BookOpen className="w-8 h-8 text-white/10 mx-auto mb-2" />
          <p className="text-xs text-white/30">No tools yet.</p>
          <p className="text-[10px] text-white/20 mt-1">Create your first tool to build the library.</p>
        </div>
      )}

      {/* Empty — no search/filter results */}
      {!loading && tools.length > 0 && filtered.length === 0 && (
        <div className="text-center py-8">
          <p className="text-xs text-white/30">No tools match your search.</p>
        </div>
      )}

      {/* Tool cards */}
      <div>
        {filtered.map(tool => {
          const cfg = CATEGORY_CONFIG[tool.category];
          const isExpanded = expandedId === tool.id;
          return (
            <div key={tool.id} className="mb-2">
              <div
                className={`rounded-lg border border-white/[0.06] overflow-hidden transition-all duration-200 hover:border-white/[0.10] cursor-pointer ${
                  isExpanded ? 'bg-white/[0.05]' : 'bg-white/[0.025]'
                }`}
                onClick={() => handleExpand(tool)}
              >
                <div className="flex items-start gap-0">
                  {/* Left accent bar */}
                  <div
                    className="w-[3px] self-stretch flex-shrink-0 rounded-l-[6px]"
                    style={{ backgroundColor: CATEGORY_COLORS[tool.category], opacity: 0.7 }}
                  />

                  <div className="flex-1 px-3 py-2.5 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium text-white/85 leading-tight">{tool.name}</span>
                        <p className="text-[11px] text-white/60 leading-relaxed mt-0.5">{tool.description}</p>
                      </div>
                      <span className={`text-[9px] px-2 py-0.5 rounded-full border flex-shrink-0 mt-0.5 ${cfg.pill}`}>
                        {cfg.label}
                      </span>
                    </div>

                    {/* Tags + action row */}
                    <div className="flex items-center justify-between mt-2">
                      <div className="flex flex-wrap gap-1">
                        {tool.tags.slice(0, 4).map(tag => (
                          <span key={tag} className="text-[9px] px-1.5 py-0.5 rounded bg-white/[0.04] text-white/25 border border-white/[0.06]">
                            {tag}
                          </span>
                        ))}
                      </div>
                      <button
                        onClick={e => { e.stopPropagation(); openEditor(tool); }}
                        className="flex items-center gap-1 text-[10px] text-white/30 hover:text-white/60 transition-colors px-1.5 py-0.5 rounded hover:bg-white/[0.06]"
                      >
                        <Pencil className="w-2.5 h-2.5" />
                        Edit guide
                      </button>
                    </div>
                  </div>
                </div>

                {/* Inline preview */}
                {isExpanded && (
                  <div className="border-t border-white/[0.06] px-4 py-3" onClick={e => e.stopPropagation()}>
                    {previewLoading === tool.id ? (
                      <div className="flex items-center gap-2 text-xs text-white/30 py-4 justify-center">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        Loading guide...
                      </div>
                    ) : previewContent[tool.id] ? (
                      <pre className="whitespace-pre-wrap font-sans text-[11px] text-white/55 leading-relaxed max-h-48 overflow-y-auto">
                        {previewContent[tool.id]}
                      </pre>
                    ) : (
                      <p className="text-xs text-white/25 py-2 text-center italic">No guide content yet.</p>
                    )}
                    <div className="flex justify-end mt-2">
                      <button
                        onClick={() => setExpandedId(null)}
                        className="text-[10px] text-white/30 hover:text-white/60 transition-colors"
                      >
                        Close
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
