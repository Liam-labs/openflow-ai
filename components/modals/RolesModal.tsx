'use client';

import { useState } from 'react';
import { Shield, Plus, X, ChevronRight, ChevronLeft, Check, Trash2, Loader2 } from 'lucide-react';
import type { AgentRole } from '@/lib/types';

interface RolesModalProps {
  show: boolean;
  onClose: () => void;
  roles: AgentRole[];
  fetchRoles: () => void;
}

export function RolesModal({ show, onClose, roles, fetchRoles }: RolesModalProps) {
  const [editingRole, setEditingRole] = useState<AgentRole | null>(null);
  const [editingRoleMd, setEditingRoleMd] = useState('');
  const [roleMdSaving, setRoleMdSaving] = useState(false);

  if (!show) return null;

  const closeEditor = () => { setEditingRole(null); setEditingRoleMd(''); };

  if (editingRole) {
    return (
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={closeEditor}>
        <div className="w-full max-w-2xl h-[75vh] bg-[#0c1a2e] border border-white/10 rounded-2xl shadow-2xl flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-between px-5 py-3 border-b border-white/[0.06]">
            <div className="flex items-center gap-2.5">
              <button
                onClick={closeEditor}
                className="p-1 rounded-md hover:bg-white/10 text-muted hover:text-white transition-colors"
                title="Back to roles"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <Shield className="w-4 h-4 text-indigo-400" />
              <h2 className="text-sm font-semibold text-white/90">{editingRole.name}</h2>
              <span className="text-[10px] text-muted font-mono">{editingRole.slug}.md</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={async () => {
                  setRoleMdSaving(true);
                  try {
                    const res = await fetch('/api/roles', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ action: 'update', roleId: editingRole.id, mdContent: editingRoleMd }),
                    });
                    const data = await res.json();
                    if (data.success) {
                      closeEditor();
                      fetchRoles();
                    } else {
                      alert(data.error || 'Failed to save');
                    }
                  } catch { alert('Network error'); }
                  setRoleMdSaving(false);
                }}
                disabled={roleMdSaving}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-green-500/15 hover:bg-green-500/25 text-green-400 border border-green-500/20 transition-colors disabled:opacity-40"
              >
                {roleMdSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                Save
              </button>
              <button
                onClick={async () => {
                  if (!confirm(`Delete role "${editingRole.name}"?`)) return;
                  try {
                    await fetch('/api/roles', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ action: 'delete', roleId: editingRole.id }),
                    });
                    closeEditor();
                    fetchRoles();
                  } catch { /* ignore */ }
                }}
                className="p-1.5 rounded-lg hover:bg-red-500/15 text-muted hover:text-red-400 transition-colors"
                title="Delete role"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
              <button onClick={closeEditor} className="p-1.5 rounded-lg hover:bg-white/10 text-muted hover:text-white transition-colors" aria-label="Close editor">
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
          <div className="flex-1 p-4 overflow-hidden">
            <textarea
              value={editingRoleMd}
              onChange={(e) => setEditingRoleMd(e.target.value)}
              className="w-full h-full bg-black/30 border border-white/[0.06] rounded-xl p-4 text-sm text-white/90 font-mono leading-relaxed resize-none focus:outline-none focus:border-indigo-500/30 placeholder:text-white/15"
              placeholder="# Role Name&#10;&#10;Write role-specific instructions here...&#10;&#10;This content is injected into the agent's system prompt via --append-system-prompt when spawned."
              spellCheck={false}
            />
          </div>
          <div className="px-5 py-2.5 border-t border-white/[0.06] text-[10px] text-muted/50">
            This .md content is injected into the agent&apos;s system prompt when spawned. Changes apply on next spawn.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-lg bg-[#0c1a2e] border border-white/10 rounded-2xl shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
          <div className="flex items-center gap-2.5">
            <Shield className="w-5 h-5 text-indigo-400" />
            <h2 className="text-base font-semibold text-white/90">Agent Roles</h2>
            <span className="text-xs text-muted">({roles.length})</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={async () => {
                const name = prompt('Role name (e.g. "Backend Dev", "Researcher"):');
                if (!name?.trim()) return;
                const desc = prompt('Short description (optional):') || '';
                try {
                  const res = await fetch('/api/roles', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'create', name: name.trim(), description: desc.trim() }),
                  });
                  const data = await res.json();
                  if (data.success) {
                    fetchRoles();
                  } else {
                    alert(data.error || 'Failed to create role');
                  }
                } catch { alert('Network error'); }
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs bg-indigo-500/15 hover:bg-indigo-500/25 text-indigo-400 border border-indigo-500/20 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              New Role
            </button>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/10 text-muted hover:text-white transition-colors" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="p-4 max-h-[60vh] overflow-y-auto">
          {roles.length === 0 ? (
            <div className="text-center py-12 text-muted">
              <Shield className="w-10 h-10 mx-auto mb-3 text-indigo-400/30" />
              <p className="text-sm">No roles defined yet</p>
              <p className="text-xs mt-1 text-muted/60">Create a role to assign specialized .md instructions to agents</p>
            </div>
          ) : (
            <div className="space-y-2">
              {roles.map(role => (
                <div
                  key={role.id}
                  className="group flex items-center gap-3 p-3 rounded-xl bg-white/[0.02] hover:bg-white/[0.05] border border-white/[0.04] hover:border-indigo-500/20 transition-all cursor-pointer"
                  onClick={async () => {
                    try {
                      const res = await fetch('/api/roles', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ action: 'get', roleId: role.id }),
                      });
                      const data = await res.json();
                      if (data.success) {
                        setEditingRole(data.data.role);
                        setEditingRoleMd(data.data.mdContent || '');
                      }
                    } catch { /* ignore */ }
                  }}
                >
                  <div className="w-10 h-10 rounded-xl bg-indigo-500/15 flex items-center justify-center flex-shrink-0">
                    <Shield className="w-5 h-5 text-indigo-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-white/85">{role.name}</div>
                    {role.description && <div className="text-xs text-muted truncate">{role.description}</div>}
                    <div className="text-[10px] text-white/20 mt-0.5 font-mono">{role.slug}.md</div>
                  </div>
                  <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <span className="text-[10px] text-indigo-400/60">Edit .md</span>
                    <ChevronRight className="w-4 h-4 text-indigo-400/40" />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
