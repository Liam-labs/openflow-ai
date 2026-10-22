'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  Globe, Cpu, Users,
  Shield, FlaskConical, BookOpen,
  FileText, FileCode, FileCog,
  Pencil, FolderOpen, Plus,
  ChevronDown, ArrowLeft,
  Check, Loader2, AlertTriangle,
} from 'lucide-react';

type ScaffoldingCategory =
  | 'global-rules'
  | 'agent-behavior'
  | 'agent-methodology'
  | 'agent-context'
  | 'per-model'
  | 'per-agent';

interface ScaffoldingFile {
  id: string;
  label: string;
  category: ScaffoldingCategory;
  absolutePath: string;
  displayPath: string;
  sizeBytes: number;
  updatedAt: string;
  isTemplate: boolean;
  exists: boolean;
  summary?: string;
  appliesTo?: string;
}

const SECTIONS: Array<{
  id: ScaffoldingCategory;
  label: string;
  icon: React.ElementType;
  iconClass: string;
}> = [
  { id: 'global-rules',      label: 'Global Rules',             icon: Globe,         iconClass: 'text-blue-400/40' },
  { id: 'agent-behavior',    label: 'Agent Behaviour',          icon: Shield,        iconClass: 'text-orange-400/40' },
  { id: 'agent-methodology', label: 'Agent Methodology',        icon: FlaskConical,  iconClass: 'text-green-400/40' },
  { id: 'agent-context',     label: 'Agent Context & Platform', icon: BookOpen,      iconClass: 'text-cyan-400/40' },
  { id: 'per-model',         label: 'Per-Model Masters',        icon: Cpu,           iconClass: 'text-purple-400/40' },
  { id: 'per-agent',         label: 'Per-Agent Templates',      icon: Users,         iconClass: 'text-emerald-400/40' },
];

function rowIcon(file: ScaffoldingFile) {
  if (file.category === 'global-rules') return <FileText className="w-4 h-4 text-white/40 flex-shrink-0" />;
  if (file.isTemplate) return <FileCode className="w-4 h-4 text-amber-400/40 flex-shrink-0" />;
  if (file.category === 'per-model') return <FileCode className="w-4 h-4 text-white/40 flex-shrink-0" />;
  return <FileCog className="w-4 h-4 text-white/40 flex-shrink-0" />;
}

export function ScaffoldingFilesPanel() {
  const [files, setFiles] = useState<ScaffoldingFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set(['global-rules', 'agent-behavior', 'agent-methodology', 'agent-context', 'per-model', 'per-agent'])
  );

  // Editor state
  const [editId, setEditId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editIsTemplate, setEditIsTemplate] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [editLoading, setEditLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');

  useEffect(() => {
    fetch('/api/settings/scaffolding')
      .then(r => r.json())
      .then(d => { if (d.success) setFiles(d.files); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const toggleSection = (id: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const openEditor = useCallback(async (file: ScaffoldingFile) => {
    setEditId(file.id);
    setEditLabel(file.label);
    setEditIsTemplate(file.isTemplate);
    setEditContent('');
    setSaveMsg('');
    setEditLoading(true);
    try {
      const res = await fetch(`/api/settings/scaffolding/${file.id}`);
      const d = await res.json();
      if (d.success) setEditContent(d.content);
    } catch { /* non-fatal */ }
    finally { setEditLoading(false); }
  }, []);

  const createFile = useCallback(async (file: ScaffoldingFile) => {
    setEditId(file.id);
    setEditLabel(file.label);
    setEditIsTemplate(file.isTemplate);
    setEditContent('');
    setSaveMsg('');
    setEditLoading(false);
  }, []);

  const handleSave = async () => {
    if (!editId) return;
    setSaving(true);
    setSaveMsg('');
    try {
      const res = await fetch(`/api/settings/scaffolding/${editId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: editContent }),
      });
      const d = await res.json();
      if (d.success) {
        setSaveMsg('✓ Saved');
        setFiles(prev => prev.map(f =>
          f.id === editId
            ? { ...f, sizeBytes: d.sizeBytes, updatedAt: d.updatedAt, exists: true }
            : f
        ));
      } else {
        setSaveMsg(`Error: ${d.error}`);
      }
    } catch {
      setSaveMsg('Error: network failure');
    } finally {
      setSaving(false);
    }
  };

  const openFolder = (absolutePath: string) => {
    fetch('/api/settings/scaffolding', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: absolutePath }),
    }).catch(() => {});
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-white/40 py-6 justify-center">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading scaffolding files...
      </div>
    );
  }

  // Editor view
  if (editId) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setEditId(null); setSaveMsg(''); }}
            className="p-1 rounded hover:bg-white/10 text-white/40 hover:text-white/70 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <span className="text-sm font-mono text-white/70 truncate">{editLabel}</span>
        </div>

        {editIsTemplate && (
          <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-amber-500/[0.08] border border-amber-500/[0.18] text-amber-300/70">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <p className="text-[11px] leading-relaxed">
              Template file — variables like{' '}
              <code className="font-mono text-amber-200/60">{'{agent_dir}'}</code> are filled at sync
              time. Don&apos;t replace them with real paths. After saving, use the{' '}
              <strong className="text-amber-300/80">Sync</strong> tab to deploy.
            </p>
          </div>
        )}

        {editLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-white/45 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading...
          </div>
        ) : (
          <textarea
            value={editContent}
            onChange={e => setEditContent(e.target.value)}
            className="w-full h-72 px-3 py-2 bg-black/40 border border-white/10 rounded-lg text-xs text-white/80 font-mono resize-none focus:border-purple-500/50 focus:outline-none leading-relaxed"
            spellCheck={false}
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

  // List view
  return (
    <div className="space-y-1">
      {SECTIONS.map(section => {
        const sectionFiles = files.filter(f => f.category === section.id);
        if (sectionFiles.length === 0) return null;
        const expanded = expandedSections.has(section.id);
        const Icon = section.icon;

        return (
          <div key={section.id}>
            <button
              onClick={() => toggleSection(section.id)}
              className="w-full flex items-center justify-between px-3 py-2 rounded-lg hover:bg-white/[0.04] transition-colors"
            >
              <div className="flex items-center gap-2">
                <Icon className={`w-3.5 h-3.5 ${section.iconClass}`} />
                <span className="text-xs font-semibold text-white/60 uppercase tracking-wider">
                  {section.label}
                </span>
                <span className="text-[10px] text-white/35 font-normal normal-case tracking-normal">
                  ({sectionFiles.length})
                </span>
              </div>
              <ChevronDown className={`w-3.5 h-3.5 text-white/40 transition-transform duration-150 ${expanded ? 'rotate-180' : ''}`} />
            </button>

            {expanded && (
              <div className="space-y-1 mt-1 mb-2 pl-1">
                {sectionFiles.map(file => (
                  <div
                    key={file.id}
                    className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-white/[0.03] border border-white/[0.05] hover:bg-white/[0.05] hover:border-white/[0.08] transition-colors"
                  >
                    {rowIcon(file)}

                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2">
                        <p className="text-sm text-white/80 font-mono truncate leading-tight">
                          {file.label}
                        </p>
                        {file.appliesTo && (
                          <span className="text-[10px] text-white/50 font-normal whitespace-nowrap flex-shrink-0">
                            · {file.appliesTo}
                          </span>
                        )}
                      </div>
                      {file.summary && (
                        <p className="text-[11px] text-white/55 truncate mt-0.5 leading-snug">
                          {file.summary}
                        </p>
                      )}
                      <p className="text-[10px] text-white/35 truncate mt-0.5">
                        {file.displayPath}
                      </p>
                    </div>

                    {!file.exists && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-400/70 border border-red-500/15 flex-shrink-0">
                        not found
                      </span>
                    )}
                    {file.isTemplate && file.exists && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400/60 border border-amber-500/15 flex-shrink-0">
                        tmpl
                      </span>
                    )}

                    <div className="flex items-center gap-1 flex-shrink-0">
                      {file.exists ? (
                        <button
                          onClick={() => openEditor(file)}
                          className="p-1.5 rounded text-white/40 hover:text-white/70 hover:bg-white/[0.08] transition-colors"
                          title="Edit file"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                      ) : (
                        <button
                          onClick={() => createFile(file)}
                          className="p-1.5 rounded text-emerald-400/40 hover:text-emerald-400/80 hover:bg-emerald-500/[0.08] transition-colors"
                          title="Create file"
                        >
                          <Plus className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <button
                        onClick={() => openFolder(file.absolutePath)}
                        className="p-1.5 rounded text-white/40 hover:text-white/70 hover:bg-white/[0.08] transition-colors"
                        title="Open folder in Explorer"
                      >
                        <FolderOpen className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
