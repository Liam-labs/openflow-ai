'use client';

/**
 * RosterConfigModal — Per-agent configuration modal for the Roster panel.
 * Consolidates: Role, Model, Harness/Runtime, and Directive editing.
 * Phase 2: Harness/Runtime selector + harness-driven model list + integration badge.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { X, Settings, Server, FileText, Check, Loader2, ChevronDown, Shield, Zap, Sparkles, Brain, Terminal, Cpu, AlertTriangle, Layers, Plus, Trash2 } from 'lucide-react';
import type { AgentRosterEntry } from '@/lib/types';
import type { OwnedSystem } from '@/lib/system-ownership';
import type { ModelIntegration, CapabilityLevel } from '@/lib/model-registry';
import {
  addSystem, removeSystem, updateSystemField,
  addPointer, updatePointer, removePointer, sanitizeSystems,
  type PointerKey,
} from '@/lib/system-ownership-edit';
import { isUncPath, getDefaultPsWorkingDirectory, supportsPowerShellSpawn } from '@/lib/roster-spawn-mode';
import { useLaptopAgents } from '@/components/useLaptopAgents';
import { HarnessLoginNotice } from '@/components/modals/HarnessLoginNotice';
import { LoginsDialog } from '@/components/LoginsDialog';
import { laptopTooltip, describeRunLocationError } from '@/lib/laptop-agents';

interface Role {
  id: string;
  name: string;
  slug?: string;
}

interface ModelEntry {
  id: string;
  aliases?: string[];
  provider: string;
  label: string;
  tier: string;
  agentTypes: string[];
  apiId?: string;
  capabilities?: {
    inputModes?: Array<'text' | 'image' | 'audio' | 'video' | 'file'>;
    outputModes?: Array<'text' | 'image' | 'audio'>;
    reasoningOnly?: boolean;
    vision?: boolean;
  };
}

type InputMode = NonNullable<NonNullable<ModelEntry['capabilities']>['inputModes']>[number];
type OutputMode = NonNullable<NonNullable<ModelEntry['capabilities']>['outputModes']>[number];

const MODE_LABEL: Record<InputMode | OutputMode, string> = {
  text: 'Text',
  image: 'Images',
  audio: 'Audio',
  video: 'Video',
  file: 'Files',
};

function modelInputModes(model?: ModelEntry): InputMode[] {
  if (model?.capabilities?.inputModes?.length) return model.capabilities.inputModes;
  return model?.capabilities?.vision ? ['text', 'image'] : ['text'];
}

function modelOutputModes(model?: ModelEntry): OutputMode[] {
  return model?.capabilities?.outputModes?.length
    ? model.capabilities.outputModes
    : ['text'];
}

function matchesModelId(model: ModelEntry, modelId: string): boolean {
  return model.id === modelId || model.aliases?.includes(modelId) === true;
}

interface RosterConfigModalProps {
  agent: AgentRosterEntry;
  channelId: string;
  roles: Role[];
  modelRegistry: ModelEntry[];
  onClose: () => void;
  onSaved: () => void;
}

type DirectivesTab = 'personality' | 'directives' | 'expertise';

// ---------------------------------------------------------------------------
// Harness / runtime — A4 (Sprint 1 Harness Parity). The harness CATALOGUE and
// its integration status are NO LONGER hand-maintained here. The list comes
// live from GET /api/models/interface-types (the detector's own
// AGENT_TYPE_TO_INTERFACE catalogue); the badge + per-capability levels come
// live from GET /api/models?includeIntegration=true (the detector output).
// The maps below are pure presentation (accent colours, capability labels) —
// they carry no truth about a harness's actual integration depth.
// ---------------------------------------------------------------------------

/** An interface-type option from GET /api/models/interface-types, optionally
 *  carrying its computed integration (A6 option β — integration on the
 *  catalogue). When absent, the badge is resolved from the per-model
 *  integration map instead (A6 option α — a scored codex model entry). */
interface HarnessInterface {
  id: string;            // canonical interfaceType (e.g. 'claude-code', 'grok-cli')
  label: string;
  description: string;
  agentTypes: string[];  // source agentTypes; [0] is the canonical one to persist
  integration?: ModelIntegration;
}

/** Per-interface accent for the selected state. Presentation only. */
const INTERFACE_ACCENT: Record<string, { text: string; bg: string }> = {
  'claude-code': { text: 'text-purple-400', bg: 'bg-purple-500/10 hover:bg-purple-500/15' },
  codex:         { text: 'text-blue-400',   bg: 'bg-blue-500/10 hover:bg-blue-500/15' },
  antigravity:   { text: 'text-emerald-400', bg: 'bg-emerald-500/10 hover:bg-emerald-500/15' },
  'gemini-cli':  { text: 'text-sky-400',    bg: 'bg-sky-500/10 hover:bg-sky-500/15' },
  'grok-cli':    { text: 'text-rose-400',   bg: 'bg-rose-500/10 hover:bg-rose-500/15' },
  ollama:        { text: 'text-slate-300',  bg: 'bg-slate-500/10 hover:bg-slate-500/15' },
};
const DEFAULT_ACCENT = { text: 'text-white/70', bg: 'hover:bg-white/[0.06]' };
function interfaceAccent(id: string) { return INTERFACE_ACCENT[id] ?? DEFAULT_ACCENT; }

/** Preferred display order + friendly labels for the detector's capabilities.
 *  Presentation only — the detector owns the real slug list; any slug not
 *  listed here renders after these, title-cased. */
const CAP_ORDER = ['hooks', 'scaffolding', 'harness', 'feed', 'skills', 'mcp', 'memory', 'telemetry'];
const CAP_LABEL: Record<string, string> = {
  hooks: 'Hooks', scaffolding: 'Scaffolding', harness: 'Harness', feed: 'Feed',
  skills: 'Skills', mcp: 'MCP', memory: 'Memory', telemetry: 'Telemetry',
};
function capLabel(slug: string): string {
  return CAP_LABEL[slug] ?? slug.charAt(0).toUpperCase() + slug.slice(1);
}
function orderedCapabilities(caps: Record<string, CapabilityLevel>): Array<[string, CapabilityLevel]> {
  const known = CAP_ORDER.filter((s) => s in caps).map((s) => [s, caps[s]] as [string, CapabilityLevel]);
  const extra = Object.keys(caps).filter((s) => !CAP_ORDER.includes(s)).sort()
    .map((s) => [s, caps[s]] as [string, CapabilityLevel]);
  return [...known, ...extra];
}
function fullCapCount(caps: Record<string, CapabilityLevel>): number {
  return Object.values(caps).filter((v) => v === 'full').length;
}
function detectedAgo(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'recently';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const STATUS_COLORS = {
  full: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  partial: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
  none: 'text-red-400/80 bg-red-500/10 border-red-500/20',
};

/**
 * Editable list of one system's pointer field (T4.2). Label + an add button,
 * then one text input per entry with a per-row remove. Mirrors the read+write
 * pattern of the Directives tab — always-editable inputs, value from state.
 */
function EditablePointerList({
  label, items, placeholder, onAdd, onUpdate, onRemove,
}: {
  label: string;
  items: string[];
  placeholder: string;
  onAdd: () => void;
  onUpdate: (index: number, value: string) => void;
  onRemove: (index: number) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] font-medium text-white/45 uppercase tracking-wider">{label}</span>
        <button
          type="button"
          onClick={onAdd}
          className="text-[10px] text-indigo-300/70 hover:text-indigo-200 flex items-center gap-0.5 px-1 py-0.5 rounded transition-colors"
        >
          <Plus className="w-3 h-3" /> Add
        </button>
      </div>
      {items.length === 0 ? (
        <p className="text-[11px] text-white/30 italic">none</p>
      ) : (
        <div className="space-y-1">
          {items.map((it, j) => (
            <div key={j} className="flex items-center gap-1.5">
              <input
                value={it}
                onChange={(e) => onUpdate(j, e.target.value)}
                placeholder={placeholder}
                className="flex-1 min-w-0 font-mono text-[11px] text-white/75 bg-black/30 border border-white/15 rounded-md px-2 py-1 focus:outline-none focus:border-indigo-400/40 placeholder:text-white/25"
              />
              <button
                type="button"
                onClick={() => onRemove(j)}
                aria-label={`Remove ${label} entry`}
                className="flex-shrink-0 w-6 h-6 rounded flex items-center justify-center text-white/30 hover:text-red-400 hover:bg-red-500/10 transition-colors"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function RosterConfigModal({
  agent,
  channelId,
  roles,
  modelRegistry,
  onClose,
  onSaved,
}: RosterConfigModalProps) {
  // Identity
  const [agentName, setAgentName] = useState(agent.name);
  const [selectedPersonality, setSelectedPersonality] = useState(agent.personality || '');
  const [personalities, setPersonalities] = useState<string[]>([]);
  const [personalitiesLoading, setPersonalitiesLoading] = useState(true);
  const identityChanged = agentName.trim() !== agent.name || selectedPersonality !== (agent.personality || '');
  const [selectedRole, setSelectedRole] = useState(agent.roleId || '');
  const [selectedModel, setSelectedModel] = useState(agent.model || '');
  // Persisted as the canonical agentType (e.g. 'claude', 'gemini'); the live
  // interface catalogue resolves variants (e.g. 'claude-terminal') to their
  // interfaceType for the badge lookup.
  const [selectedHarness, setSelectedHarness] = useState<string>(agent.agentType || 'claude');
  const [roleDropdownOpen, setRoleDropdownOpen] = useState(false);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [harnessDropdownOpen, setHarnessDropdownOpen] = useState(false);
  const roleRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const harnessRef = useRef<HTMLDivElement>(null);

  // Spawn mode
  const [spawnMode, setSpawnMode] = useState<'wsl' | 'powershell'>(agent.spawnMode === 'powershell' ? 'powershell' : 'wsl');
  // Runs on the laptop (the DevFlow server). Moving a running agent between desktop and laptop is refused by the server.
  const startedOnLaptop = agent.runLocation === 'server';
  const [onLaptop, setOnLaptop] = useState(startedOnLaptop);
  const laptop = useLaptopAgents();
  const [showLogins, setShowLogins] = useState(false);
  const agentIsLive = !!agent.status && agent.status !== 'stopped' && agent.status !== 'crashed';
  const STOP_TO_MOVE = 'Stop the agent to move it';
  const [psWorkingDirectory, setPsWorkingDirectory] = useState<string>(
    agent.psWorkingDirectory || getDefaultPsWorkingDirectory(agent.name)
  );
  const [psWdError, setPsWdError] = useState<string | null>(null);

  // Codex effort and Fast mode can be changed in the running TUI. Other
  // harnesses retain the existing spawn-time effort behavior.
  type EffortLevel = '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  const initialCodex = agent.agentType === 'codex';
  const initialEffort = (agent.liveEffort || agent.effort || (initialCodex ? 'medium' : '')) as EffortLevel;
  const [effort, setEffort] = useState<EffortLevel>(initialEffort);
  const [liveModel, setLiveModel] = useState(agent.liveModel || agent.model || '');
  const [liveEffort, setLiveEffort] = useState<EffortLevel>((agent.liveEffort as EffortLevel) || initialEffort);
  const [fastMode, setFastMode] = useState(agent.liveFastMode ?? agent.fastMode ?? false);
  const [liveFastMode, setLiveFastMode] = useState(agent.liveFastMode ?? agent.fastMode ?? false);


  // Directives
  const [directivesTab, setDirectivesTab] = useState<DirectivesTab>('personality');
  const [directivesContent, setDirectivesContent] = useState<Record<DirectivesTab, string>>({
    personality: '',
    directives: '',
    expertise: '',
  });
  const [directivesDirty, setDirectivesDirty] = useState<Record<DirectivesTab, boolean>>({
    personality: false,
    directives: false,
    expertise: false,
  });
  const [directivesLoading, setDirectivesLoading] = useState(true);

  // System Ownership (read-only display — T3.1). Graceful-empty by contract:
  // an absent/malformed SystemOwnership.json resolves to [] (not an error).
  const [systemsOwned, setSystemsOwned] = useState<OwnedSystem[]>([]);
  const [systemsLoading, setSystemsLoading] = useState(true);
  const [systemsDirty, setSystemsDirty] = useState(false);

  // Harness integration (A4) — live from the detector, never hand-maintained.
  // List + meta from /api/models/interface-types; badge + capability levels
  // from /api/models?includeIntegration=true (grouped by interfaceType).
  const [harnessInterfaces, setHarnessInterfaces] = useState<HarnessInterface[]>([]);
  const [integrationByInterface, setIntegrationByInterface] = useState<Record<string, ModelIntegration>>({});
  const [harnessLoading, setHarnessLoading] = useState(true);

  // UI state
  const [isDirty, setIsDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const markDirty = useCallback(() => setIsDirty(true), []);

  useEffect(() => {
    let cancelled = false;
    async function loadPersonalities() {
      try {
        const response = await fetch('/api/collab/pty', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'personalities_list' }),
        });
        const data = await response.json();
        if (!cancelled && data.success && Array.isArray(data.personalities)) {
          setPersonalities(data.personalities.filter((name: unknown): name is string => typeof name === 'string'));
        }
      } catch { /* keep the current identity selectable */ }
      finally { if (!cancelled) setPersonalitiesLoading(false); }
    }
    loadPersonalities();
    return () => { cancelled = true; };
  }, []);

  const handleSpawnModeChange = useCallback((mode: 'wsl' | 'powershell') => {
    setSpawnMode(mode);
    markDirty();
  }, [markDirty]);

  const handlePsWorkingDirectoryChange = useCallback((value: string) => {
    setPsWorkingDirectory(value);
    if (isUncPath(value)) {
      setPsWdError('UNC paths (\\\\server\\...) are not allowed. Use a local Windows drive path like C:\\Users\\...');
    } else {
      setPsWdError(null);
    }
    markDirty();
  }, [markDirty]);

  // When harness changes, clear selected model if it's incompatible with the new harness.
  const handleHarnessChange = useCallback((harnessId: string) => {
    setSelectedHarness(harnessId);
    setHarnessDropdownOpen(false);
    // Only Claude implements Windows per-message mode. Other harnesses launch
    // in persistent WSL/tmux sessions, so do not carry a stale PowerShell
    // choice across a Claude -> Codex/Gemini/etc. switch.
    if (!supportsPowerShellSpawn(harnessId)) {
      setSpawnMode('wsl');
    }
    if (harnessId === 'codex' && !effort) setEffort('medium');
    // Clear model if it's not compatible with the new harness
    if (selectedModel) {
      const modelEntry = modelRegistry.find(m => matchesModelId(m, selectedModel));
      if (modelEntry && !modelEntry.agentTypes.includes(harnessId)) {
        setSelectedModel('');
      }
    }
    markDirty();
  }, [selectedModel, modelRegistry, effort, markDirty]);

  // Systems Owned edit handlers (T4.2) — thin wrappers over the pure helpers in
  // system-ownership-edit. Each marks the section dirty so Save activates and
  // handleSave's step 3 fires the roster_system_ownership_write.
  const markSystemsDirty = useCallback(() => { setSystemsDirty(true); markDirty(); }, [markDirty]);
  const onAddSystem = useCallback(() => { setSystemsOwned(s => addSystem(s)); markSystemsDirty(); }, [markSystemsDirty]);
  const onRemoveSystem = useCallback((i: number) => { setSystemsOwned(s => removeSystem(s, i)); markSystemsDirty(); }, [markSystemsDirty]);
  const onSystemField = useCallback((i: number, f: 'name' | 'description', v: string) => { setSystemsOwned(s => updateSystemField(s, i, f, v)); markSystemsDirty(); }, [markSystemsDirty]);
  const onAddPointer = useCallback((i: number, k: PointerKey) => { setSystemsOwned(s => addPointer(s, i, k)); markSystemsDirty(); }, [markSystemsDirty]);
  const onUpdatePointer = useCallback((i: number, k: PointerKey, pi: number, v: string) => { setSystemsOwned(s => updatePointer(s, i, k, pi, v)); markSystemsDirty(); }, [markSystemsDirty]);
  const onRemovePointer = useCallback((i: number, k: PointerKey, pi: number) => { setSystemsOwned(s => removePointer(s, i, k, pi)); markSystemsDirty(); }, [markSystemsDirty]);

  // Close dropdowns on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (roleRef.current && !roleRef.current.contains(e.target as Node)) setRoleDropdownOpen(false);
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) setModelDropdownOpen(false);
      if (harnessRef.current && !harnessRef.current.contains(e.target as Node)) setHarnessDropdownOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Load directives on mount
  useEffect(() => {
    async function loadDirectives() {
      try {
        const res = await fetch('/api/collab/pty', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'roster_directives_read', channelId, agentId: agent.id }),
        });
        const data = await res.json();
        if (data.success) {
          setDirectivesContent({
            personality: data.personality || '',
            directives: data.directives || '',
            expertise: data.expertise || '',
          });
        }
      } catch {
        // non-fatal
      } finally {
        setDirectivesLoading(false);
      }
    }
    loadDirectives();
  }, [agent.id, channelId]);

  // Read the live TUI footer when this is an already-running Codex agent. The
  // roster remains the durable setting, but this makes the panel honest when
  // someone changed /model or /fast directly in the terminal.
  useEffect(() => {
    if (agent.agentType !== 'codex') return;
    let cancelled = false;
    async function loadLiveCodexConfig() {
      try {
        const response = await fetch('/api/collab/pty', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'roster_list', channelId }),
        });
        const data = await response.json();
        const current = (data.agents ?? []).find((item: AgentRosterEntry) => item.id === agent.id) as AgentRosterEntry | undefined;
        if (cancelled || !current) return;
        if (current.liveModel) setLiveModel(current.liveModel);
        if (current.liveEffort) {
          setLiveEffort(current.liveEffort as EffortLevel);
        }
        if (current.liveFastMode !== undefined) {
          setLiveFastMode(current.liveFastMode);
        }
      } catch {
        // Non-fatal: persisted roster values remain visible.
      }
    }
    void loadLiveCodexConfig();
    return () => { cancelled = true; };
  }, [agent.agentType, agent.id, channelId]);

  // Load system ownership on mount — same endpoint + auth (the pty route's
  // requireAuthOrLocal) as roster_directives_read; only the action differs.
  useEffect(() => {
    async function loadSystems() {
      try {
        const res = await fetch('/api/collab/pty', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'roster_system_ownership_read', channelId, agentId: agent.id }),
        });
        const data = await res.json();
        // Server already normalizes; Array.isArray is the client-side defense.
        if (data.success && Array.isArray(data.systems)) {
          setSystemsOwned(data.systems as OwnedSystem[]);
        }
      } catch {
        // non-fatal — leaves the graceful-empty state
      } finally {
        setSystemsLoading(false);
      }
    }
    loadSystems();
  }, [agent.id, channelId]);

  // Load harness interface catalogue + live integration (A4). Two GETs:
  //  - /api/models/interface-types → the harness list (+ integration if A6 β lands)
  //  - /api/models?includeIntegration=true → integration grouped by interfaceType
  // Both are read-only + localhost-allowed; failures degrade to an empty/neutral
  // readout rather than blocking the modal. Detector is the single source of
  // truth — this component never hand-maintains harness status.
  useEffect(() => {
    let cancelled = false;
    async function loadHarnessIntegration() {
      try {
        const [ifaceRes, modelsRes] = await Promise.all([
          fetch('/api/models/interface-types'),
          fetch('/api/models?includeIntegration=true'),
        ]);
        const ifaceData = await ifaceRes.json();
        const modelsData = await modelsRes.json();
        if (cancelled) return;

        // Group per-model integration by interfaceType. Models of one interface
        // share an identical block; keep the highest-status seen so a populated
        // block always wins over an empty/legacy one.
        const RANK: Record<CapabilityLevel, number> = { none: 0, partial: 1, full: 2 };
        const byIface: Record<string, ModelIntegration> = {};
        for (const m of (modelsData?.models ?? [])) {
          const integ = m?.integration as ModelIntegration | undefined;
          if (!integ?.interfaceType) continue;
          const existing = byIface[integ.interfaceType];
          if (!existing || RANK[integ.status] > RANK[existing.status]) {
            byIface[integ.interfaceType] = integ;
          }
        }

        const options: HarnessInterface[] = (ifaceData?.interfaceTypes ?? []).map((o: HarnessInterface) => ({
          id: o.id,
          label: o.label,
          description: o.description,
          agentTypes: o.agentTypes ?? [],
          integration: o.integration, // present only if A6 β lands
        }));

        setHarnessInterfaces(options);
        setIntegrationByInterface(byIface);
      } catch {
        // non-fatal — leaves an empty/neutral harness readout
      } finally {
        if (!cancelled) setHarnessLoading(false);
      }
    }
    loadHarnessIntegration();
    return () => { cancelled = true; };
  }, []);

  const updateDirective = useCallback((tab: DirectivesTab, value: string) => {
    setDirectivesContent(prev => ({ ...prev, [tab]: value }));
    setDirectivesDirty(prev => ({ ...prev, [tab]: true }));
    markDirty();
  }, [markDirty]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);

    try {
      // Block save if PS path is invalid
      if (!onLaptop && spawnMode === 'powershell' && isUncPath(psWorkingDirectory)) {
        setError('Cannot save: UNC paths are not allowed for PowerShell working directory.');
        setSaving(false);
        return;
      }

      // 1. Save identity + MCP + spawn mode + harness via roster_update
      const updateRes = await fetch('/api/collab/pty', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: identityChanged ? 'roster_identity_switch' : 'roster_update',
          channelId,
          agentId: agent.id,
          name: agentName.trim(),
          personality: selectedPersonality || undefined,
          agentType: selectedHarness || undefined,
          roleId: selectedRole || undefined,
          model: selectedModel || undefined,
          mcpServers: agent.mcpServers || [],
          spawnMode: onLaptop ? 'wsl' : spawnMode,
          ...(onLaptop !== startedOnLaptop ? { runLocation: onLaptop ? 'server' : null } : {}),
          psWorkingDirectory: !onLaptop && spawnMode === 'powershell' ? psWorkingDirectory : undefined,
          effort: selectedHarness === 'codex' ? (effort || 'medium') : effort,
          fastMode: selectedHarness === 'codex' ? fastMode : undefined,
        }),
      });
      const updateData = await updateRes.json();
      if (!updateData.success) {
        setError(updateData.code ? describeRunLocationError(updateData.code, updateData.error) : (updateData.error || 'Failed to save agent config'));
        return;
      }

      // 2. Save dirty directive files
      for (const tab of (['personality', 'directives', 'expertise'] as DirectivesTab[])) {
        if (!directivesDirty[tab]) continue;
        const dirRes = await fetch('/api/collab/pty', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'roster_directives_write',
            channelId,
            agentId: agent.id,
            file: tab,
            content: directivesContent[tab],
          }),
        });
        const dirData = await dirRes.json();
        if (!dirData.success) {
          setError(dirData.error || `Failed to save ${tab}`);
          return;
        }
      }

      // 3. Save systems ownership if edited (T4.2). Full-replace write — the
      // server normalizes (trims + drops nameless) and returns the read-back,
      // which we reflect so the UI matches disk and the dirty flag clears.
      if (systemsDirty) {
        const sysRes = await fetch('/api/collab/pty', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'roster_system_ownership_write',
            channelId,
            agentId: agent.id,
            systems: sanitizeSystems(systemsOwned),
          }),
        });
        const sysData = await sysRes.json();
        if (!sysData.success) {
          setError(sysData.error || 'Failed to save systems ownership');
          return;
        }
        if (Array.isArray(sysData.systems)) setSystemsOwned(sysData.systems as OwnedSystem[]);
        setSystemsDirty(false);
      }

      if (updateData.identityRestartRequired) {
        const response = await fetch('/api/collab/pty', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'roster_spawn', channelId, agentId: agent.id }),
        });
        const result = await response.json();
        if (!response.ok || !result.success) {
          setError(`Identity/settings were saved, but the agent is stopped: ${result.error || 'restart failed'}. Use Start to retry.`);
          return;
        }
      }

      if (updateData.runtimeApply?.state === 'failed') {
        setIsDirty(false);
        setError(`Settings were saved, but the running Codex session could not be updated: ${updateData.runtimeApply.message || 'unknown error'}. They will apply on its next restart.`);
        return;
      }

      onSaved();
    } catch {
      setError('Network error — is the server running?');
    } finally {
      setSaving(false);
    }
  };

  const statusColor =
    agent.status === 'running' ? 'bg-green-400' :
    agent.status === 'starting' ? 'bg-amber-400' :
    'bg-gray-500'; // crashed shown as stopped — crash details in .AppData/crash-logs

  const selectedRoleName = roles.find(r => r.id === selectedRole)?.name;
  const selectedModelEntry = modelRegistry.find(m => matchesModelId(m, selectedModel));
  const selectedInputModes = selectedModelEntry ? modelInputModes(selectedModelEntry) : [];
  const selectedOutputModes = selectedModelEntry ? modelOutputModes(selectedModelEntry) : [];
  // The interface the current agentType belongs to (handles variants like
  // 'claude-terminal' → claude-code, since options carry the agentTypes list).
  const selectedInterface = harnessInterfaces.find(o => o.agentTypes.includes(selectedHarness));
  const selectedAccent = interfaceAccent(selectedInterface?.id ?? '');
  const isCodexHarness = selectedHarness === 'codex';
  const effortLabel = (value: EffortLevel) => value
    ? ({ xhigh: 'Extra high', low: 'Low', medium: 'Medium', high: 'High', max: 'Max', ultra: 'Ultra' } as Record<string, string>)[value] ?? value
    : 'Default';

  // Models compatible with the currently selected harness. Collapse entries
  // that invoke the identical model (same apiId — e.g. `opus` and `opus[1m]`
  // both → claude-opus-4-8[1m]) to a single option, preferring the currently
  // selected id so the active model always renders with its checkmark.
  const harnessCompatibleModels = (() => {
    const byApiId = new Map<string, ModelEntry>();
    for (const m of modelRegistry) {
      if (!m.agentTypes.includes(selectedHarness)) continue;
      const key = m.apiId || m.id;
      const existing = byApiId.get(key);
      if (!existing || m.id === selectedModel) byApiId.set(key, m);
    }
    return [...byApiId.values()];
  })();
  // Unique providers in the filtered set, preserving a stable order
  const PROVIDER_ORDER = ['anthropic', 'google', 'deepseek', 'xai', 'openai', 'openrouter', 'ollama'];
  const harnessProviders = PROVIDER_ORDER.filter(p =>
    harnessCompatibleModels.some(m => m.provider === p)
  ).concat(
    [...new Set(harnessCompatibleModels.map(m => m.provider))].filter(p => !PROVIDER_ORDER.includes(p))
  );

  const PROVIDER_LABEL: Record<string, string> = {
    anthropic: 'Claude', google: 'Gemini', deepseek: 'DeepSeek',
    xai: 'Grok', openai: 'OpenAI', openrouter: 'OpenRouter', ollama: 'Ollama',
  };
  const PROVIDER_SELECTED_COLOR: Record<string, string> = {
    anthropic: 'text-purple-400 bg-purple-500/10 hover:bg-purple-500/15',
    google: 'text-blue-400 bg-blue-500/10 hover:bg-blue-500/15',
    deepseek: 'text-teal-400 bg-teal-500/10 hover:bg-teal-500/15',
    xai: 'text-amber-400 bg-amber-500/10 hover:bg-amber-500/15',
    openai: 'text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/15',
  };
  const PROVIDER_CHECK_COLOR: Record<string, string> = {
    anthropic: 'text-purple-400', google: 'text-blue-400',
    deepseek: 'text-teal-400', xai: 'text-amber-400', openai: 'text-emerald-400',
  };

  const modelIcon = (m: ModelEntry) => {
    if (m.provider === 'anthropic') {
      return m.tier === 'powerful'
        ? <Brain className="w-3 h-3 text-purple-400/60" />
        : m.tier === 'balanced'
        ? <Sparkles className="w-3 h-3 text-emerald-400/60" />
        : <Zap className="w-3 h-3 text-sky-400/60" />;
    }
    if (m.provider === 'google') return <Sparkles className="w-3 h-3 text-blue-400/60" />;
    if (m.provider === 'deepseek') return <Zap className="w-3 h-3 text-teal-400/60" />;
    return <Zap className="w-3 h-3 text-amber-400/60" />;
  };

  // Integration for the selected harness — prefer the block carried on the
  // interface option (A6 β), fall back to the per-model integration map keyed
  // by interfaceType (A6 α). Undefined when no detector source exists yet
  // (e.g. codex pre-A6) → renders a neutral 'not yet detected' state.
  const harnessIntegration: ModelIntegration | undefined =
    selectedInterface?.integration ??
    (selectedInterface ? integrationByInterface[selectedInterface.id] : undefined);

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-end sm:items-center sm:justify-center z-50 sm:p-4"
      onClick={onClose}
    >
      <div
        className="sheet-enter bg-[#0a1628] rounded-t-2xl sm:rounded-2xl border border-white/20 shadow-[0_-12px_40px_-8px_rgba(0,0,0,0.5)] sm:shadow-[0_24px_80px_-20px_rgba(0,0,0,0.6)] w-full sm:max-w-[676px] max-h-[92svh] sm:max-h-[90vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Mobile drag handle */}
        <div className="flex justify-center pt-3 pb-1 sm:hidden flex-shrink-0">
          <div className="w-10 h-1 rounded-full bg-white/20" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-white/[0.06] bg-gradient-to-r from-white/[0.03] to-transparent flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="relative flex-shrink-0">
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center text-[10px] font-bold"
                style={{ backgroundColor: agent.color || '#8B5CF6' }}
              >
                {agent.name[0].toUpperCase()}
              </div>
              <div className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-[#0a1628] ${statusColor}`} />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white/90 leading-tight">
                {agent.name}{isDirty ? ' *' : ''}
              </h2>
              <p className="text-[11px] text-white/55 leading-none mt-0.5">Agent Configuration</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-white/[0.06] transition-colors"
          >
            <X className="w-4 h-4 text-white/55" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto scrollbar-none px-4 sm:px-6 py-5 space-y-5">
          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/25 rounded-xl text-red-400 text-sm">
              {error}
            </div>
          )}

          {/* Section A — Identity */}
          <div>
            <div className="text-xs font-medium text-white/70 uppercase tracking-wider mb-3 flex items-center gap-2">
              <Settings className="w-3 h-3" />
              Identity
            </div>

            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label htmlFor="roster-agent-name" className="text-xs font-medium text-white/70 uppercase tracking-wider mb-1.5 block">Agent name</label>
                <input id="roster-agent-name" value={agentName} maxLength={64}
                  onChange={event => { setAgentName(event.target.value); markDirty(); }}
                  className="w-full bg-black/30 border border-white/20 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-purple-500/30" />
              </div>
              <div>
                <label htmlFor="roster-personality" className="text-xs font-medium text-white/70 uppercase tracking-wider mb-1.5 block">Name / personality preset</label>
                <select id="roster-personality" value={selectedPersonality} disabled={personalitiesLoading}
                  onChange={event => {
                    const value = event.target.value;
                    setSelectedPersonality(value);
                    setAgentName(value);
                    if (psWorkingDirectory === getDefaultPsWorkingDirectory(agent.name)) setPsWorkingDirectory(getDefaultPsWorkingDirectory(value));
                    // The selected preset replaces the old personality prose.
                    setDirectivesDirty(previous => ({ ...previous, personality: false }));
                    markDirty();
                  }}
                  className="w-full bg-[#0e1c32] border border-white/20 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-purple-500/30">
                  <option value="" disabled>{personalitiesLoading ? 'Loading presets…' : 'Choose a preset'}</option>
                  {selectedPersonality && !personalities.includes(selectedPersonality) && <option value={selectedPersonality}>{selectedPersonality} (current)</option>}
                  {personalities.map(name => <option key={name} value={name}>{name}</option>)}
                </select>
              </div>
            </div>
            {identityChanged && <p className="text-xs text-amber-300/80 mb-3">
              Save switches this agent’s identity. A running agent stops safely and restarts with a fresh conversation.
              Role, model and assigned tasks stay attached to this roster entry; the old workspace is retained.
            </p>}

            {/* Harness / Runtime selector (2.1) */}
            <div className="mb-3">
              <label className="text-xs font-medium text-white/70 uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
                <Cpu className="w-3 h-3" />
                Harness / Runtime
              </label>
              <div className="relative" ref={harnessRef}>
                <button
                  type="button"
                  onClick={() => { setHarnessDropdownOpen(o => !o); setRoleDropdownOpen(false); setModelDropdownOpen(false); }}
                  className="w-full flex items-center justify-between gap-2 bg-black/30 border border-white/20 rounded-xl px-3 py-2.5 text-sm text-left transition-colors hover:border-white/[0.15] focus:outline-none focus:border-purple-500/30"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={selectedInterface ? selectedAccent.text : 'text-white/55'}>
                      {selectedInterface?.label ?? selectedHarness ?? 'Select harness'}
                    </span>
                    {/* Aggregate integration badge — live from the detector (A4) */}
                    {harnessLoading ? (
                      <Loader2 className="w-3 h-3 text-white/40 animate-spin flex-shrink-0" />
                    ) : harnessIntegration ? (
                      <span className={`text-[9px] px-1.5 py-0.5 rounded border font-semibold tracking-wide uppercase flex-shrink-0 ${STATUS_COLORS[harnessIntegration.status]}`}>
                        {harnessIntegration.status}
                      </span>
                    ) : (
                      <span className="text-[9px] px-1.5 py-0.5 rounded border font-semibold tracking-wide uppercase flex-shrink-0 text-white/55 bg-white/[0.06] border-white/15">
                        not detected
                      </span>
                    )}
                  </div>
                  <ChevronDown className={`w-3.5 h-3.5 text-white/55 flex-shrink-0 transition-transform ${harnessDropdownOpen ? 'rotate-180' : ''}`} />
                </button>

                {harnessDropdownOpen && (
                  <div className="absolute top-full left-0 right-0 mt-1 z-50 bg-[#0e1c32] border border-white/20 rounded-xl shadow-2xl py-1 overflow-hidden max-h-72 overflow-y-auto scrollbar-none">
                    {harnessLoading ? (
                      <div className="flex items-center gap-2 px-3 py-2.5 text-[11px] text-white/55">
                        <Loader2 className="w-3 h-3 animate-spin" /> Loading harnesses...
                      </div>
                    ) : harnessInterfaces.length === 0 ? (
                      <div className="px-3 py-2.5 text-[11px] text-white/45 italic">No harnesses available.</div>
                    ) : harnessInterfaces.map(h => {
                      const integ = h.integration ?? integrationByInterface[h.id];
                      const accent = interfaceAccent(h.id);
                      const isSel = h.agentTypes.includes(selectedHarness);
                      return (
                        <button
                          key={h.id}
                          type="button"
                          onClick={() => handleHarnessChange(h.agentTypes[0] ?? h.id)}
                          className={`w-full text-left px-3 py-2.5 text-sm transition-colors flex items-start gap-2.5 ${
                            isSel ? `${accent.text} ${accent.bg}` : 'text-white/70 hover:bg-white/[0.06]'
                          }`}
                        >
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="font-medium leading-none">{h.label}</span>
                              {integ ? (
                                <span className={`text-[8px] px-1 py-0 rounded border font-semibold tracking-wide uppercase flex-shrink-0 ${STATUS_COLORS[integ.status]}`}>
                                  {integ.status}
                                </span>
                              ) : (
                                <span className="text-[8px] px-1 py-0 rounded border font-semibold tracking-wide uppercase flex-shrink-0 text-white/40 bg-white/[0.04] border-white/15">
                                  n/d
                                </span>
                              )}
                            </div>
                            <p className="text-[10px] text-white/55 mt-0.5 leading-relaxed">{h.description}</p>
                          </div>
                          {isSel && <Check className={`w-3 h-3 mt-0.5 flex-shrink-0 ${accent.text}`} />}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Integration detail (A4) — per-capability levels live from the
                  detector; no hand-maintained note. */}
              {!harnessLoading && (
                <div className="mt-2">
                  {harnessIntegration ? (
                    <>
                      <div className="flex flex-wrap gap-1.5">
                        {orderedCapabilities(harnessIntegration.capabilities).map(([slug, level]) => (
                          <span
                            key={slug}
                            className={`text-[9px] px-1.5 py-0.5 rounded border font-medium tracking-wide flex-shrink-0 ${STATUS_COLORS[level]}`}
                            title={`${capLabel(slug)}: ${level}`}
                          >
                            {capLabel(slug)} · {level}
                          </span>
                        ))}
                      </div>
                      {harnessIntegration.detectedAt && (
                        <p className="text-[10px] text-white/40 mt-1.5">
                          Detected {detectedAgo(harnessIntegration.detectedAt)} · {fullCapCount(harnessIntegration.capabilities)}/{Object.keys(harnessIntegration.capabilities).length} capabilities full
                        </p>
                      )}
                    </>
                  ) : (
                    <div className="flex items-start gap-1.5 text-white/45">
                      <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0 text-white/35" />
                      <p className="text-[10px] leading-relaxed">
                        Not yet detected — no scored model maps to this harness. The badge appears once detection covers it.
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              {/* Role custom dropdown */}
              <div>
                <label className="text-xs font-medium text-white/70 uppercase tracking-wider mb-1.5 block">
                  Role
                </label>
                <div className="relative" ref={roleRef}>
                  <button
                    type="button"
                    onClick={() => { setRoleDropdownOpen(o => !o); setModelDropdownOpen(false); setHarnessDropdownOpen(false); }}
                    className="w-full flex items-center justify-between gap-2 bg-black/30 border border-white/20 rounded-xl px-3 py-2.5 text-sm text-left transition-colors hover:border-white/[0.15] focus:outline-none focus:border-purple-500/30"
                  >
                    <span className={selectedRoleName ? 'text-white' : 'text-white/55'}>
                      {selectedRoleName || 'No role'}
                    </span>
                    <ChevronDown className={`w-3.5 h-3.5 text-white/55 flex-shrink-0 transition-transform ${roleDropdownOpen ? 'rotate-180' : ''}`} />
                  </button>
                  {roleDropdownOpen && (
                    <div className="absolute top-full left-0 right-0 mt-1 z-50 bg-[#0e1c32] border border-white/20 rounded-xl shadow-2xl py-1 overflow-hidden max-h-[220px] overflow-y-auto">
                      <button
                        type="button"
                        onClick={() => { setSelectedRole(''); markDirty(); setRoleDropdownOpen(false); }}
                        className={`w-full text-left px-3 py-2 text-sm transition-colors hover:bg-white/[0.06] flex items-center gap-2 ${!selectedRole ? 'text-white/60' : 'text-white/55'}`}
                      >
                        No role
                        {!selectedRole && <Check className="w-3 h-3 ml-auto text-white/65" />}
                      </button>
                      <div className="border-t border-white/[0.06] my-1" />
                      {roles.map(r => (
                        <button
                          key={r.id}
                          type="button"
                          onClick={() => { setSelectedRole(r.id); markDirty(); setRoleDropdownOpen(false); }}
                          className={`w-full text-left px-3 py-2 text-sm transition-colors flex items-center gap-2 ${
                            selectedRole === r.id
                              ? 'text-indigo-400 bg-indigo-500/10 hover:bg-indigo-500/15'
                              : 'text-white/70 hover:bg-white/[0.06]'
                          }`}
                        >
                          <Shield className="w-3 h-3 text-indigo-400/50 flex-shrink-0" />
                          {r.name}
                          {selectedRole === r.id && <Check className="w-3 h-3 ml-auto text-indigo-400" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Model custom dropdown — filtered by selected harness (2.2) */}
              <div>
                <label className="text-xs font-medium text-white/70 uppercase tracking-wider mb-1.5 block">
                  Model
                  {isCodexHarness && liveModel && (
                    <span className="ml-2 normal-case font-normal text-white/55 tracking-normal">
                      Current: {modelRegistry.find(model => matchesModelId(model, liveModel))?.label || liveModel} · applies live on Save
                    </span>
                  )}
                </label>
                <div className="relative" ref={modelRef}>
                  <button
                    type="button"
                    onClick={() => { setModelDropdownOpen(o => !o); setRoleDropdownOpen(false); setHarnessDropdownOpen(false); }}
                    className="w-full flex items-center justify-between gap-2 bg-black/30 border border-white/20 rounded-xl px-3 py-2.5 text-sm text-left transition-colors hover:border-white/[0.15] focus:outline-none focus:border-purple-500/30"
                  >
                    <span className={selectedModelEntry ? 'text-white' : 'text-white/55'}>
                      {selectedModelEntry?.label || 'Default'}
                    </span>
                    <ChevronDown className={`w-3.5 h-3.5 text-white/55 flex-shrink-0 transition-transform ${modelDropdownOpen ? 'rotate-180' : ''}`} />
                  </button>
                  {modelDropdownOpen && (
                    <div className="absolute top-full left-0 right-0 mt-1 z-50 bg-[#0e1c32] border border-white/20 rounded-xl shadow-2xl py-1 overflow-hidden max-h-[240px] overflow-y-auto">
                      <button
                        type="button"
                        onClick={() => { setSelectedModel(''); markDirty(); setModelDropdownOpen(false); }}
                        className={`w-full text-left px-3 py-2 text-sm transition-colors hover:bg-white/[0.06] flex items-center gap-2 ${!selectedModel ? 'text-white/60' : 'text-white/55'}`}
                      >
                        Default
                        {!selectedModel && <Check className="w-3 h-3 ml-auto text-white/65" />}
                      </button>
                      {harnessCompatibleModels.length === 0 ? (
                        <div className="px-3 py-3 text-[11px] text-white/55 text-center">
                          No models registered for this harness yet.
                        </div>
                      ) : (
                        harnessProviders.map(provider => {
                          const providerModels = harnessCompatibleModels.filter(m => m.provider === provider);
                          if (providerModels.length === 0) return null;
                          const providerLabel = PROVIDER_LABEL[provider] ?? provider;
                          const selectedColor = PROVIDER_SELECTED_COLOR[provider] ?? 'text-white/80 bg-white/10 hover:bg-white/15';
                          const checkColor = PROVIDER_CHECK_COLOR[provider] ?? 'text-white/60';
                          return (
                            <div key={provider}>
                              <div className="border-t border-white/[0.06] my-1" />
                              <div className="px-3 py-1 text-[9px] uppercase tracking-wider text-white/45 font-semibold">{providerLabel}</div>
                              {providerModels.map(m => (
                                <button
                                  key={m.id}
                                  type="button"
                                  onClick={() => { setSelectedModel(m.id); markDirty(); setModelDropdownOpen(false); }}
                                  className={`w-full text-left px-3 py-2 text-sm transition-colors flex items-center gap-2 ${
                                    selectedModelEntry?.id === m.id ? selectedColor : 'text-white/70 hover:bg-white/[0.06]'
                                  }`}
                                >
                                  {modelIcon(m)}
                                  {m.label}
                                  {m.capabilities?.reasoningOnly && (
                                    <span
                                      className="px-1.5 py-0 rounded text-[9px] font-medium bg-amber-500/15 text-amber-300/80 border border-amber-500/20"
                                      title="Reasoning-only model — no tool use or streaming"
                                    >
                                      reasoning-only
                                    </span>
                                  )}
                                  {selectedModelEntry?.id === m.id && (
                                    <Check className={`w-3 h-3 ml-auto ${checkColor}`} />
                                  )}
                                </button>
                              ))}
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {selectedModelEntry && (
              <div
                className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 border-y border-white/[0.06] py-2.5"
                aria-label={`${selectedModelEntry.label} input and output modes`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-[9px] font-semibold uppercase tracking-[0.14em] text-white/40">Input</span>
                  <div className="flex flex-wrap gap-1">
                    {selectedInputModes.map(mode => (
                      <span key={mode} className="rounded-md border border-sky-400/20 bg-sky-400/[0.07] px-1.5 py-0.5 text-[10px] font-medium text-sky-200/80">
                        {MODE_LABEL[mode]}
                      </span>
                    ))}
                  </div>
                </div>
                <span className="hidden h-4 w-px bg-white/10 sm:block" aria-hidden="true" />
                <div className="flex items-center gap-2">
                  <span className="text-[9px] font-semibold uppercase tracking-[0.14em] text-white/40">Output</span>
                  <div className="flex flex-wrap gap-1">
                    {selectedOutputModes.map(mode => (
                      <span key={mode} className="rounded-md border border-emerald-400/20 bg-emerald-400/[0.07] px-1.5 py-0.5 text-[10px] font-medium text-emerald-200/80">
                        {MODE_LABEL[mode]}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <HarnessLoginNotice harness={selectedHarness} onLaptop={onLaptop} />

            {/* Reasoning depth. Codex applies it to the active TUI on Save;
                other harnesses pick it up on their next spawn. */}
            <div className="mt-4">
              <label className="text-xs font-medium text-white/70 uppercase tracking-wider mb-2 block">
                Effort
                <span className="ml-2 normal-case font-normal text-white/55 tracking-normal">
                  Current: {effortLabel(liveEffort)} · {isCodexHarness ? 'applies live on Save' : 'applies on next respawn'}
                </span>
              </label>
              <div className="grid grid-cols-3 sm:flex sm:flex-wrap gap-2">
                {([
                  { value: '' as const,       label: 'Default' },
                  { value: 'low' as const,    label: 'Low' },
                  { value: 'medium' as const, label: 'Medium' },
                  { value: 'high' as const,   label: 'High' },
                  { value: 'xhigh' as const,  label: 'Extra high' },
                  { value: 'max' as const,    label: 'Max' },
                  { value: 'ultra' as const,  label: 'Ultra' },
                ]).filter(({ value }) => isCodexHarness ? value !== '' : value !== 'ultra').map(({ value, label }) => (
                  <button
                    key={value || 'default'}
                    type="button"
                    onClick={() => { setEffort(value); markDirty(); }}
                    className={`flex items-center justify-center sm:justify-start gap-1.5 sm:gap-2 px-2 sm:px-3 py-2 rounded-xl border text-sm font-medium transition-colors ${
                      effort === value
                        ? 'bg-indigo-500/15 border-indigo-500/30 text-indigo-300'
                        : 'bg-black/20 border-white/20 text-white/65 hover:border-white/20 hover:text-white/85'
                    }`}
                  >
                    <span className={`w-3 h-3 rounded-full border flex-shrink-0 flex items-center justify-center ${
                      effort === value ? 'border-indigo-400' : 'border-white/20'
                    }`}>
                      {effort === value && <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 block" />}
                    </span>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {isCodexHarness && (
              <div className="mt-4 rounded-xl border border-blue-500/20 bg-blue-500/[0.06] px-3 py-3 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <label htmlFor="codex-fast-mode" className="text-xs font-medium text-white/75 uppercase tracking-wider flex items-center gap-1.5">
                    <Zap className="w-3.5 h-3.5 text-amber-300" />
                    Fast Mode
                  </label>
                  <p className="text-[10px] text-white/50 mt-1">
                    1.5× faster, with increased usage · currently {liveFastMode ? 'on' : 'off'}
                  </p>
                </div>
                <button
                  id="codex-fast-mode"
                  type="button"
                  role="switch"
                  aria-checked={fastMode}
                  onClick={() => { setFastMode(value => !value); markDirty(); }}
                  className={`relative h-7 w-12 flex-shrink-0 rounded-full border transition-colors ${
                    fastMode
                      ? 'bg-amber-400/25 border-amber-300/40'
                      : 'bg-black/30 border-white/20'
                  }`}
                >
                  <span className={`absolute top-1 h-5 w-5 rounded-full transition-transform ${
                    fastMode ? 'translate-x-6 bg-amber-300' : 'translate-x-1 bg-white/45'
                  }`} />
                </button>
              </div>
            )}

            {/* Where it runs: locally on the desktop, or remote on the laptop */}
            <div className="mt-4">
              <label className="text-xs font-medium text-white/70 uppercase tracking-wider mb-2 flex items-center gap-2">
                <Server className="w-3 h-3" />
                Where it runs
              </label>
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Where it runs">
                {([
                  { id: 'local', label: 'Run locally', hint: 'On your desktop', checked: !onLaptop,
                    disabled: startedOnLaptop && agentIsLive, title: startedOnLaptop && agentIsLive ? STOP_TO_MOVE : undefined,
                    pick: () => { setOnLaptop(false); markDirty(); } },
                  { id: 'remote', label: 'Run remote', hint: 'On the remote server', checked: onLaptop,
                    disabled: (!laptop.ready && !startedOnLaptop) || (!startedOnLaptop && agentIsLive),
                    title: !startedOnLaptop && agentIsLive ? STOP_TO_MOVE : (!laptop.ready && !startedOnLaptop ? laptop.reason : laptopTooltip(laptop.mode)),
                    pick: () => { setOnLaptop(true); setSpawnMode('wsl'); markDirty(); } },
                ]).map(option => (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={option.checked}
                    onClick={option.pick}
                    disabled={option.disabled}
                    title={option.title}
                    className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-sm font-medium transition-colors ${
                      option.checked
                        ? 'bg-indigo-500/15 border-indigo-500/30 text-indigo-300'
                        : option.disabled
                          ? 'bg-black/10 border-white/10 text-white/25 cursor-not-allowed'
                          : 'bg-black/20 border-white/20 text-white/65 hover:border-white/20 hover:text-white/85'
                    }`}
                  >
                    <span className={`w-3 h-3 rounded-full border flex-shrink-0 flex items-center justify-center ${
                      option.checked ? 'border-indigo-400' : 'border-white/20'
                    }`}>
                      {option.checked && <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 block" />}
                    </span>
                    <span>
                      {option.label}
                      <span className="block text-[10px] font-normal text-white/40">{option.hint}</span>
                    </span>
                  </button>
                ))}
              </div>
              {agentIsLive && (
                <p className="mt-1.5 text-[11px] text-white/45">{STOP_TO_MOVE} between local and remote.</p>
              )}
              {onLaptop !== startedOnLaptop && (
                <p className="mt-1.5 text-[11px] text-white/55">Takes effect when the agent is next started.</p>
              )}
              {onLaptop && (
                <p className="mt-1.5 text-[11px] text-white/55">{laptopTooltip(laptop.mode)}</p>
              )}
              {!onLaptop && !agentIsLive && !laptop.ready && !laptop.loading && (
                <p className="mt-1.5 text-[11px] text-white/35">Run remote is not available yet: {laptop.reason}</p>
              )}
              {!onLaptop && !laptop.ready && !laptop.loading && laptop.failingCheckId === 'signed-in' && (
                <button type="button" onClick={() => setShowLogins(true)} className="mt-1 text-[11px] text-sky-300 underline hover:text-sky-200">Sign in on the remote server</button>
              )}
              {showLogins && <LoginsDialog onClose={() => setShowLogins(false)} />}
            </div>

            {/* Spawn mode (local agents only) */}
            {!onLaptop && <div className="mt-4">
              <label className="text-xs font-medium text-white/70 uppercase tracking-wider mb-2 flex items-center gap-2">
                <Terminal className="w-3 h-3" />
                Spawn on
              </label>
              <div className="flex gap-2" role="radiogroup" aria-label="Spawn on">
                {(['wsl', 'powershell'] as const).map(mode => {
                  const disabled = mode === 'powershell' && !supportsPowerShellSpawn(selectedHarness);
                  return (
                    <button
                      key={mode}
                      type="button"
                      role="radio"
                      aria-checked={spawnMode === mode}
                      onClick={() => { if (!disabled) handleSpawnModeChange(mode); }}
                      disabled={disabled}
                      title={disabled ? 'PowerShell per-message mode is available only for the Claude harness' : undefined}
                      className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-sm font-medium transition-colors ${
                        spawnMode === mode
                          ? 'bg-indigo-500/15 border-indigo-500/30 text-indigo-300'
                          : disabled
                            ? 'bg-black/10 border-white/10 text-white/25 cursor-not-allowed'
                            : 'bg-black/20 border-white/20 text-white/65 hover:border-white/20 hover:text-white/85'
                      }`}
                    >
                      <span className={`w-3 h-3 rounded-full border flex-shrink-0 flex items-center justify-center ${
                        spawnMode === mode ? 'border-indigo-400' : 'border-white/20'
                      }`}>
                        {spawnMode === mode && <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 block" />}
                      </span>
                      {mode === 'wsl' ? 'WSL (tmux)' : 'PowerShell'}
                    </button>
                  );
                })}
              </div>

              {/* Conditional Windows working directory for PowerShell mode */}
              {spawnMode === 'powershell' && (
                <div className="mt-3">
                  <label className="text-xs font-medium text-white/70 uppercase tracking-wider mb-1.5 block">
                    Windows Working Directory
                  </label>
                  <input
                    type="text"
                    value={psWorkingDirectory}
                    onChange={e => handlePsWorkingDirectoryChange(e.target.value)}
                    className={`w-full bg-black/30 border rounded-xl px-3 py-2 text-sm font-mono transition-colors focus:outline-none ${
                      psWdError
                        ? 'border-red-500/40 text-red-300 focus:border-red-500/60'
                        : 'border-white/20 text-white/80 focus:border-indigo-500/30'
                    }`}
                    placeholder="D:\Projects\Team\AgentName"
                    spellCheck={false}
                  />
                  {psWdError && (
                    <p className="mt-1.5 text-[11px] text-red-400/80">{psWdError}</p>
                  )}
                  <p className="mt-1 text-[11px] text-white/55">
                    Must be a local Windows path. UNC paths (\\server\...) are refused.
                  </p>
                </div>
              )}
            </div>}
          </div>

          <div className="border-t border-white/[0.06]" />

          {/* Section C — Directives */}
          <div>
            <div className="text-xs font-medium text-white/70 uppercase tracking-wider mb-3 flex items-center gap-2">
              <FileText className="w-3 h-3" />
              Directives
            </div>

            {/* Tab strip */}
            <div className="flex gap-1 mb-3 bg-black/20 rounded-lg p-1">
              {(['personality', 'directives', 'expertise'] as DirectivesTab[]).map(tab => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setDirectivesTab(tab)}
                  className={`flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors capitalize flex items-center justify-center gap-1 ${
                    directivesTab === tab
                      ? 'bg-white/[0.08] text-white/90'
                      : 'text-white/55 hover:text-white/85'
                  }`}
                >
                  {tab}
                  {directivesDirty[tab] && (
                    <span className="text-amber-400 text-[10px]">*</span>
                  )}
                </button>
              ))}
            </div>

            {/* Textarea */}
            {directivesTab === 'personality' && selectedPersonality !== (agent.personality || '') ? (
              <p className="text-xs text-white/65 py-4">The {selectedPersonality} preset replaces this personality on Save. Reopen the panel after saving to edit the new personality.</p>
            ) : directivesLoading ? (
              <div className="flex items-center gap-2 py-6 text-[11px] text-white/55 justify-center">
                <Loader2 className="w-3 h-3 animate-spin" />
                Loading directives...
              </div>
            ) : (
              <textarea
                value={directivesContent[directivesTab]}
                onChange={e => updateDirective(directivesTab, e.target.value)}
                onKeyDown={e => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                    e.preventDefault();
                    if (isDirty && !saving) handleSave();
                  }
                }}
                rows={8}
                className="w-full bg-black/30 border border-white/20 rounded-xl px-4 py-3 text-sm text-white/80 placeholder:text-white/45 focus:outline-none focus:border-purple-500/30 transition-colors resize-none font-mono leading-relaxed max-h-[35vh] sm:max-h-none"
                placeholder={`${directivesTab.charAt(0).toUpperCase() + directivesTab.slice(1)} content...`}
                spellCheck={false}
              />
            )}
          </div>

          <div className="border-t border-white/[0.06]" />

          {/* Section D — Systems Owned (editable, T4.2). Always-editable inputs
              (mirrors the Directives tab); Save → roster_system_ownership_write. */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="text-xs font-medium text-white/70 uppercase tracking-wider flex items-center gap-2">
                <Layers className="w-3 h-3" />
                Systems Owned
              </div>
              {!systemsLoading && (
                <button
                  type="button"
                  onClick={onAddSystem}
                  className="text-[11px] text-indigo-300/80 hover:text-indigo-100 flex items-center gap-1 px-2 py-1 rounded-md bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/25 transition-colors"
                >
                  <Plus className="w-3 h-3" /> Add system
                </button>
              )}
            </div>

            {systemsLoading ? (
              <div className="flex items-center gap-2 py-3 text-[11px] text-white/55">
                <Loader2 className="w-3 h-3 animate-spin" />
                Loading systems...
              </div>
            ) : systemsOwned.length === 0 ? (
              <p className="text-[12px] text-white/45 italic">Owns no systems yet. Use &ldquo;Add system&rdquo; to grant ownership.</p>
            ) : (
              <div className="space-y-3">
                {systemsOwned.map((sys, i) => (
                  <div
                    key={i}
                    className="rounded-xl border border-white/20 bg-black/20 p-3.5 space-y-3"
                  >
                    <div className="flex items-start gap-2">
                      <div className="flex-1 min-w-0 space-y-2">
                        <input
                          value={sys.name}
                          onChange={(e) => onSystemField(i, 'name', e.target.value)}
                          placeholder="System name (e.g. Scaffolding)"
                          className="w-full text-sm font-semibold text-white/90 bg-black/30 border border-white/15 rounded-md px-2.5 py-1.5 focus:outline-none focus:border-indigo-400/40 placeholder:text-white/30 placeholder:font-normal"
                        />
                        <input
                          value={sys.description}
                          onChange={(e) => onSystemField(i, 'description', e.target.value)}
                          placeholder="Short description of what this system is / why it's owned"
                          className="w-full text-[12px] text-white/65 bg-black/30 border border-white/15 rounded-md px-2.5 py-1.5 focus:outline-none focus:border-indigo-400/40 placeholder:text-white/30"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => onRemoveSystem(i)}
                        aria-label={`Remove ${sys.name || 'system'}`}
                        title="Remove system"
                        className="flex-shrink-0 w-7 h-7 rounded-md flex items-center justify-center text-white/35 hover:text-red-400 hover:bg-red-500/10 border border-white/10 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <EditablePointerList label="KBs" items={sys.kbs} placeholder="path/to/kb.md"
                      onAdd={() => onAddPointer(i, 'kbs')} onUpdate={(j, v) => onUpdatePointer(i, 'kbs', j, v)} onRemove={(j) => onRemovePointer(i, 'kbs', j)} />
                    <EditablePointerList label="Guides" items={sys.guides} placeholder="path/to/guide.md"
                      onAdd={() => onAddPointer(i, 'guides')} onUpdate={(j, v) => onUpdatePointer(i, 'guides', j, v)} onRemove={(j) => onRemovePointer(i, 'guides', j)} />
                    <EditablePointerList label="Skills" items={sys.skills} placeholder="skill-name"
                      onAdd={() => onAddPointer(i, 'skills')} onUpdate={(j, v) => onUpdatePointer(i, 'skills', j, v)} onRemove={(j) => onRemovePointer(i, 'skills', j)} />
                    <EditablePointerList label="Directories" items={sys.keyDirectories} placeholder="path/to/dir"
                      onAdd={() => onAddPointer(i, 'keyDirectories')} onUpdate={(j, v) => onUpdatePointer(i, 'keyDirectories', j, v)} onRemove={(j) => onRemovePointer(i, 'keyDirectories', j)} />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 sm:px-6 py-3 sm:py-4 border-t border-white/[0.06] flex-shrink-0 bg-black/20">
          {isDirty ? (
            <span className="text-[11px] text-amber-400/70 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400/60 inline-block flex-shrink-0" />
              Unsaved changes
            </span>
          ) : (
            <span className="text-[11px] text-white/45">No changes</span>
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-white/[0.04] hover:bg-white/[0.08] text-white/70 rounded-xl font-medium transition-colors text-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!isDirty || saving}
              className="px-4 py-2 bg-purple-500/15 hover:bg-purple-500/25 text-purple-400 border border-purple-500/20 rounded-xl font-medium transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100 text-sm"
            >
              {saving ? (
                <span className="flex items-center gap-1.5">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Saving...
                </span>
              ) : (
                'Save Changes'
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
