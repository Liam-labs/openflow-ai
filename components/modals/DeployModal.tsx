'use client';

import React, { useState, useMemo } from 'react';
import { X, Rocket, ChevronDown, Loader2 } from 'lucide-react';
import type { CollabChannel } from '@/lib/types';

interface DeployModalProps {
  activeChannel: CollabChannel;
  participantId: string;
  onClose: () => void;
}

const DEPLOYMENT_TYPES = [
  'New Site',
  'Application',
  'Service',
  'Server',
  'Cron Job',
  'WebGate Deployment',
] as const;

type DeploymentType = typeof DEPLOYMENT_TYPES[number];

export function DeployModal({ activeChannel, participantId, onClose }: DeployModalProps) {
  const [deploymentType, setDeploymentType] = useState<DeploymentType | ''>('');
  const [name, setName] = useState('');
  const [fallbackHandle, setFallbackHandle] = useState('');
  const [typeDropdownOpen, setTypeDropdownOpen] = useState(false);
  const [assigneeDropdownOpen, setAssigneeDropdownOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onlineAgents = useMemo(() => {
    return activeChannel.participants.filter(
      p => p.type !== 'user' && (p.status === 'online' || p.status === 'away')
    );
  }, [activeChannel.participants]);

  const teamLead = useMemo(() => {
    if (!activeChannel.teamLeadId) return null;
    return onlineAgents.find(p => p.id === activeChannel.teamLeadId) ?? null;
  }, [activeChannel.teamLeadId, onlineAgents]);

  const initialAssigneeId = teamLead?.id ?? onlineAgents[0]?.id ?? '';
  const [assigneeId, setAssigneeId] = useState(initialAssigneeId);

  const noAgentsOnline = onlineAgents.length === 0;
  const selectedAssignee = onlineAgents.find(p => p.id === assigneeId);
  const canSubmit = deploymentType !== '' && name.trim() !== '' && (assigneeId !== '' || fallbackHandle.trim() !== '');

  const handleSubmit = async () => {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);

    try {
      const assigneeName = selectedAssignee?.name ?? fallbackHandle.trim();
      const senderName = activeChannel.participants.find(p => p.id === participantId)?.name ?? 'User';

      const content = `@${assigneeName} — Deploy request from ${senderName}\n\nType: ${deploymentType}\nName: ${name.trim()}\n\n**How to register a Service/Server in DevFlow (2-step process):**\n\n1. Start in PM2: \`pm2 start "your-command" --name "service-name" && pm2 save\`\n\n2. Create project entry:\n\`\`\`\ncurl -s -X POST http://localhost:3000/api/agent -H "Authorization: Bearer $DEVFLOW_API_TOKEN" -H "Content-Type: application/json" -d '{"action":"projects.create","name":"Service Name","path":"/path/to/service","category":"service"}'\n\`\`\`\n\n3. Add server config (REQUIRED for Services panel visibility):\n\`\`\`\ncurl -s -X POST http://localhost:3000/api/agent -H "Authorization: Bearer $DEVFLOW_API_TOKEN" -H "Content-Type: application/json" -d '{"action":"projects.update","projectId":"<id-from-step-2>","server":{"pm2Name":"service-name","port":YOUR_PORT,"startCommand":"your-command"}}'\n\`\`\`\n\n4. Verify: Check Systems > Services in DevFlow.\n\nFull guide: ~/DevFlow/data/central-knowledge-base/platform/devflow-systems-tab.md`;

      const body: Record<string, unknown> = {
        action: 'message',
        channelId: activeChannel.id,
        participantId,
        content,
        mentions: selectedAssignee ? [selectedAssignee.id] : [],
        metadata: { deliveryMode: 'targeted' },
      };

      if (selectedAssignee) {
        body.recipients = [selectedAssignee.id];
      }

      await fetch('/api/collab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      onClose();
    } catch {
      setError('Failed to send — is the server running?');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="modal-enter bg-[#0a1628] rounded-2xl border border-white/[0.08] shadow-[0_24px_80px_-20px_rgba(0,0,0,0.6)] w-full max-w-[420px] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06] bg-gradient-to-r from-white/[0.03] to-transparent">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-blue-500/15 border border-blue-500/20 flex items-center justify-center">
              <Rocket className="w-3.5 h-3.5 text-blue-400" />
            </div>
            <h2 className="text-base font-semibold text-white/90">Deploy</h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-white/[0.06] transition-colors"
          >
            <X className="w-4 h-4 text-muted" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">
          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/25 rounded-xl text-red-400 text-sm">
              {error}
            </div>
          )}

          {/* Deployment Type */}
          <div>
            <label className="text-xs font-medium text-muted uppercase tracking-wider mb-1.5 block">
              What are you deploying?
            </label>
            <div className="relative">
              <button
                type="button"
                onClick={() => { setTypeDropdownOpen(o => !o); setAssigneeDropdownOpen(false); }}
                className="w-full flex items-center justify-between gap-2 bg-black/30 border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm text-left transition-colors hover:border-white/[0.15] focus:outline-none focus:border-blue-500/30"
              >
                <span className={deploymentType ? 'text-white' : 'text-white/30'}>
                  {deploymentType || 'Select type...'}
                </span>
                <ChevronDown className={`w-3.5 h-3.5 text-muted flex-shrink-0 transition-transform ${typeDropdownOpen ? 'rotate-180' : ''}`} />
              </button>
              {typeDropdownOpen && (
                <div className="absolute top-full left-0 right-0 mt-1 z-50 bg-[#0e1c32] border border-white/10 rounded-xl shadow-2xl py-1 overflow-hidden">
                  {DEPLOYMENT_TYPES.map(t => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => { setDeploymentType(t); setTypeDropdownOpen(false); }}
                      className={`w-full text-left px-3 py-2 text-sm transition-colors hover:bg-white/[0.06] ${
                        deploymentType === t ? 'text-blue-400 bg-blue-500/10' : 'text-white/70'
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Name / description */}
          <div>
            <label htmlFor="deploy-name" className="text-xs font-medium text-muted uppercase tracking-wider mb-1.5 block">
              Name / description
            </label>
            <input
              id="deploy-name"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Acme client site"
              className="w-full bg-black/30 border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm text-white/90 placeholder:text-white/25 focus:outline-none focus:border-blue-500/30 transition-colors"
            />
          </div>

          {/* Assign to */}
          <div>
            <label className="text-xs font-medium text-muted uppercase tracking-wider mb-1.5 block">
              Assign to
            </label>
            {noAgentsOnline ? (
              <input
                type="text"
                value={fallbackHandle}
                onChange={e => setFallbackHandle(e.target.value)}
                placeholder="Enter a name or handle to notify"
                className="w-full bg-black/30 border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm text-white/90 placeholder:text-white/25 focus:outline-none focus:border-blue-500/30 transition-colors"
              />
            ) : (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => { setAssigneeDropdownOpen(o => !o); setTypeDropdownOpen(false); }}
                  className="w-full flex items-center justify-between gap-2 bg-black/30 border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm text-left transition-colors hover:border-white/[0.15] focus:outline-none focus:border-blue-500/30"
                >
                  <span className={selectedAssignee ? 'text-white' : 'text-white/30'}>
                    {selectedAssignee
                      ? `${selectedAssignee.name}${selectedAssignee.id === activeChannel.teamLeadId ? ' (Team Lead)' : ''}`
                      : 'Select assignee...'}
                  </span>
                  <ChevronDown className={`w-3.5 h-3.5 text-muted flex-shrink-0 transition-transform ${assigneeDropdownOpen ? 'rotate-180' : ''}`} />
                </button>
                {assigneeDropdownOpen && (
                  <div className="absolute bottom-full left-0 right-0 mb-1 z-50 bg-[#0e1c32] border border-white/10 rounded-xl shadow-2xl py-1 overflow-hidden max-h-[180px] overflow-y-auto">
                    {onlineAgents.map(p => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => { setAssigneeId(p.id); setAssigneeDropdownOpen(false); }}
                        className={`w-full text-left px-3 py-2 text-sm transition-colors hover:bg-white/[0.06] flex items-center gap-2 ${
                          assigneeId === p.id ? 'text-blue-400 bg-blue-500/10' : 'text-white/70'
                        }`}
                      >
                        <span className="flex-1">{p.name}</span>
                        {p.id === activeChannel.teamLeadId && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 font-medium flex-shrink-0">
                            Team Lead
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-white/[0.06] bg-black/20">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-white/[0.04] hover:bg-white/[0.08] text-white/50 rounded-xl font-medium transition-colors text-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit || submitting}
            className="px-4 py-2 bg-blue-500/15 hover:bg-blue-500/25 text-blue-400 border border-blue-500/20 rounded-xl font-medium transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100 text-sm flex items-center gap-1.5"
          >
            {submitting ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Deploying...
              </>
            ) : (
              <>
                Deploy
                <Rocket className="w-3.5 h-3.5" />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
