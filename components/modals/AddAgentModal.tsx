'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  Boxes,
  Check,
  CheckCircle2,
  ChevronDown,
  Crown,
  Database,
  Eye,
  Loader2,
  Monitor,
  PenTool,
  Plus,
  Radio,
  Rocket,
  RotateCcw,
  Search,
  Server,
  Sparkles,
  Terminal,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { AgentRole, AgentRosterEntry, CollabChannel } from '@/lib/types';
import type { ModelEntry } from '@/components/colab-types';
import { DirectoryAutocomplete } from '@/components/DirectoryAutocomplete';
import { useLaptopAgents } from '@/components/useLaptopAgents';
import { LoginsDialog } from '@/components/LoginsDialog';
import { HarnessLoginNotice } from '@/components/modals/HarnessLoginNotice';
import { laptopTooltip, describeRunLocationError } from '@/lib/laptop-agents';
import { PRODUCT_NAME } from '@/lib/brand';

export type EffortLevel = '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
type SpawnMode = 'wsl' | 'powershell';

type SubmitState = 'idle' | 'adding' | 'checking' | 'starting' | 'success' | 'partial' | 'duplicate';

interface AddAgentModalProps {
  channel: CollabChannel;
  roles: AgentRole[];
  modelRegistry: ModelEntry[];
  projectDirectory: string;
  onClose: () => void;
  onRosterChanged: () => void;
}

const ROLE_ORDER = [
  'team-lead',
  'frontend-dev',
  'backend-dev',
  'architect',
  'researcher',
  'designer',
  'axiom',
  'operations',
  'overseer',
];

const ROLE_VISUALS: Record<string, { icon: LucideIcon; code: string }> = {
  'team-lead': { icon: Crown, code: 'LEAD' },
  'frontend-dev': { icon: Monitor, code: 'UI' },
  'backend-dev': { icon: Database, code: 'API' },
  architect: { icon: Boxes, code: 'SYS' },
  researcher: { icon: Search, code: 'R&D' },
  designer: { icon: PenTool, code: 'DES' },
  axiom: { icon: Sparkles, code: 'AXM' },
  operations: { icon: Radio, code: 'OPS' },
  overseer: { icon: Eye, code: 'OVR' },
};

const CANONICAL_HARNESSES = ['claude', 'gemini', 'grok', 'codex', 'antigravity'] as const;
const HARNESS_LABELS: Record<string, string> = {
  claude: 'Claude',
  gemini: 'Gemini',
  grok: 'Grok',
  codex: 'Codex',
  antigravity: 'Antigravity',
};

function compatibleHarnesses(model: ModelEntry | undefined): string[] {
  if (!model) return ['claude'];
  return model.agentTypes.filter((type) => (CANONICAL_HARNESSES as readonly string[]).includes(type));
}

export function effortOptions(agentType: string, model: ModelEntry | undefined): EffortLevel[] {
  if (model?.capabilities?.reasoning === false) return [];
  if (agentType === 'codex') return ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  if (agentType === 'claude') return ['low', 'medium', 'high', 'xhigh', 'max'];
  if (agentType === 'antigravity') return ['low', 'medium', 'high'];
  return [];
}

function progressLabel(state: SubmitState): string {
  if (state === 'adding') return 'Adding to roster…';
  if (state === 'checking') return 'Checking roster…';
  if (state === 'starting') return 'Starting agent…';
  return '';
}

interface RosterResponseData {
  success?: boolean;
  error?: string;
  code?: string;
  agent?: AgentRosterEntry;
  agents?: AgentRosterEntry[];
  _duplicate?: boolean;
}

async function readJson(response: Response): Promise<RosterResponseData> {
  try {
    return await response.json();
  } catch {
    return { success: false, error: `Request failed (${response.status})` };
  }
}

export function AddAgentModal({
  channel,
  roles,
  modelRegistry,
  projectDirectory,
  onClose,
  onRosterChanged,
}: AddAgentModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const busyRef = useRef(false);
  const onCloseRef = useRef(onClose);
  const [roleId, setRoleId] = useState('');
  const [characterId, setCharacterId] = useState('');
  const [modelId, setModelId] = useState('');
  const [harnessOverride, setHarnessOverride] = useState('');
  const [effort, setEffort] = useState<EffortLevel>('');
  const [spawnMode, setSpawnMode] = useState<SpawnMode>('wsl');
  // Runs on the laptop (the DevFlow server) instead of the desktop. Needs the laptop to be ready.
  const [onLaptop, setOnLaptop] = useState(false);
  const laptop = useLaptopAgents();
  const [showLogins, setShowLogins] = useState(false);
  useEffect(() => { if (onLaptop && !laptop.loading && !laptop.ready) setOnLaptop(false); }, [onLaptop, laptop.loading, laptop.ready]);
  // Reason PowerShell mode can't start here (DevFlow on the server has no Windows Claude); '' = available.
  const [powershellUnavailable, setPowershellUnavailable] = useState('');
  useEffect(() => {
    let cancelled = false;
    fetch('/api/collab/pty', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'spawn_capabilities' }),
    })
      .then((response) => response.json())
      .then((data) => {
        if (cancelled || !data?.success || data.powershell) return;
        setPowershellUnavailable(data.powershellReason || 'PowerShell mode is unavailable here.');
        setSpawnMode('wsl');
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const [directory, setDirectory] = useState(projectDirectory);
  const [advancedOpen, setAdvancedOpen] = useState(!projectDirectory);
  const [submitState, setSubmitState] = useState<SubmitState>('idle');
  const [error, setError] = useState('');
  const [resultAgent, setResultAgent] = useState<AgentRosterEntry | null>(null);
  const [resultStarted, setResultStarted] = useState(false);
  const [removeConfirm, setRemoveConfirm] = useState(false);
  const [addedCount, setAddedCount] = useState(0);

  // Characters invented this session for roles whose named characters were all in use.
  const [inventedNames, setInventedNames] = useState<Record<string, string[]>>({});
  const [inventing, setInventing] = useState(false);

  const busy = submitState === 'adding' || submitState === 'checking' || submitState === 'starting';
  busyRef.current = busy;
  onCloseRef.current = onClose;
  const selectedRole = roles.find((role) => role.id === roleId);
  const selectedModel = modelRegistry.find((model) => model.id === modelId);
  const harnesses = compatibleHarnesses(selectedModel);
  const inferredHarness = harnesses[0] || 'claude';
  const agentType = harnessOverride && harnesses.includes(harnessOverride) ? harnessOverride : inferredHarness;
  const availableEfforts = effortOptions(agentType, selectedModel);
  const usedNames = useMemo(
    () => new Set((channel.roster?.agents || []).map((agent) => agent.name.toLowerCase())),
    [channel.roster?.agents],
  );
  const orderedRoles = useMemo(
    () => [...roles]
      .filter((role) => (role.characterIds?.length || 0) > 0)
      .sort((a, b) => {
        const ai = ROLE_ORDER.indexOf(a.slug);
        const bi = ROLE_ORDER.indexOf(b.slug);
        return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
      }),
    [roles],
  );

  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const first = dialog?.querySelector<HTMLElement>('[data-autofocus]');
    first?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) return;
      const firstItem = focusable[0];
      const lastItem = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previousFocusRef.current?.focus();
    };
  }, []);

  useEffect(() => {
    if (spawnMode === 'powershell' && agentType !== 'claude') setSpawnMode('wsl');
    if (effort && !availableEfforts.includes(effort)) setEffort('');
  }, [agentType, availableEfforts, effort, spawnMode]);

  const roleCharacters = (role: AgentRole) =>
    [...(role.characterIds || []), ...(inventedNames[role.id] || []).filter((n) => !(role.characterIds || []).includes(n))];

  // Owner request (28 Sep 2026): running out of named characters must not block adding
  // another agent of a role — invent a fitting new character instead.
  const inventCharacter = async (role: AgentRole) => {
    setInventing(true);
    setError('');
    try {
      const response = await fetch('/api/collab/pty', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'role_character_generate', roleId: role.id, channelId: channel.id }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success || typeof data.name !== 'string') {
        setError(data.error || 'Could not create a new character. Try again.');
        return;
      }
      setInventedNames((current) => ({ ...current, [role.id]: [...(current[role.id] || []), data.name] }));
      setCharacterId(data.name);
    } catch {
      setError('Could not create a new character. Try again.');
    } finally {
      setInventing(false);
    }
  };

  const chooseRole = (role: AgentRole) => {
    const characters = roleCharacters(role);
    const defaultCandidate = role.defaultCharacterId && !usedNames.has(role.defaultCharacterId.toLowerCase())
      ? role.defaultCharacterId
      : characters.find((name) => !usedNames.has(name.toLowerCase())) || '';
    const recommendedModel = role.recommendedModelId && modelRegistry.some((model) => model.id === role.recommendedModelId)
      ? role.recommendedModelId
      : '';
    setRoleId(role.id);
    setCharacterId(defaultCandidate);
    setModelId(recommendedModel);
    setHarnessOverride('');
    setEffort('');
    setSpawnMode('wsl');
    setError('');
  };

  const resetForAnother = () => {
    setRoleId('');
    setCharacterId('');
    setModelId('');
    setHarnessOverride('');
    setEffort('');
    setSpawnMode('wsl');
    setDirectory(projectDirectory);
    setAdvancedOpen(!projectDirectory);
    setSubmitState('idle');
    setError('');
    setResultAgent(null);
    setResultStarted(false);
    setRemoveConfirm(false);
    requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus());
  };

  const refreshRoster = async () => {
    await Promise.resolve(onRosterChanged());
  };

  const checkRosterAfterAmbiguousAdd = async () => {
    setSubmitState('checking');
    try {
      const response = await fetch('/api/collab/pty', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'roster_list', channelId: channel.id }),
      });
      const data = await readJson(response);
      const found = Array.isArray(data.agents)
        ? data.agents.find((agent) => agent.name.toLowerCase() === characterId.toLowerCase())
        : null;
      if (found) {
        setResultAgent(found);
        setResultStarted(found.status === 'running');
        setSubmitState(found.status === 'running' ? 'duplicate' : 'partial');
        setError(found.status === 'running'
          ? `${found.name} is already in this channel.`
          : `${found.name} is in the roster. Start was not retried automatically.`);
      } else {
        setSubmitState('idle');
        setError('The request did not complete. Nothing was added; you can try again.');
      }
    } catch {
      setSubmitState('idle');
      setError('Could not confirm whether the agent was added. Refresh the roster before retrying.');
    } finally {
      await refreshRoster();
    }
  };

  const startAgent = async (agent: AgentRosterEntry) => {
    setSubmitState('starting');
    setError('');
    try {
      const response = await fetch('/api/collab/pty', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'roster_spawn', channelId: channel.id, agentId: agent.id }),
      });
      const data = await readJson(response);
      if (!response.ok || !data.success) {
        setSubmitState('partial');
        setError(data.error || `${agent.name} was added, but could not start.`);
        await refreshRoster();
        return;
      }
      setResultStarted(true);
      setSubmitState('success');
      await refreshRoster();
    } catch {
      setSubmitState('partial');
      setError(`${agent.name} was added, but the start result could not be confirmed.`);
      await refreshRoster();
    }
  };

  const addAndStart = async () => {
    if (!selectedRole) {
      setError('Choose a role first.');
      dialogRef.current?.querySelector<HTMLElement>('[role="radiogroup"] button')?.focus();
      return;
    }
    if (!characterId) {
      setError('Choose an available character.');
      dialogRef.current?.querySelector<HTMLElement>('[aria-label="Character"] button')?.focus();
      return;
    }
    if (!directory.trim()) {
      setAdvancedOpen(true);
      setError('This channel has no project directory. Add one under Advanced.');
      requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLInputElement>('input[placeholder*="directory" i]')?.focus());
      return;
    }

    setSubmitState('adding');
    setError('');
    try {
      const response = await fetch('/api/collab/pty', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'roster_add',
          channelId: channel.id,
          name: characterId,
          workingDirectory: directory.trim(),
          autoResume: true,
          useCollabWrapper: true,
          dangerouslySkipPermissions: true,
          roleId: selectedRole.id,
          personality: characterId,
          model: modelId || undefined,
          agentType,
          effort: effort || undefined,
          spawnMode: !onLaptop && spawnMode === 'powershell' ? 'powershell' : undefined,
          runLocation: onLaptop ? 'server' : undefined,
        }),
      });
      const data = await readJson(response);
      if (!response.ok || !data.success || !data.agent) {
        setSubmitState('idle');
        setError(data.code ? describeRunLocationError(data.code, data.error) : (data.error || 'Could not add the agent.'));
        await refreshRoster();
        return;
      }
      if (data._duplicate) {
        setResultAgent(data.agent as AgentRosterEntry);
        setResultStarted(data.agent.status === 'running');
        setSubmitState('duplicate');
        setError(`${data.agent.name} is already in this channel. The existing agent was not started again.`);
        await refreshRoster();
        return;
      }

      const agent = data.agent as AgentRosterEntry;
      setResultAgent(agent);
      setAddedCount((count) => count + 1);
      await startAgent(agent);
    } catch {
      await checkRosterAfterAmbiguousAdd();
    }
  };

  const removePartialAgent = async () => {
    if (!resultAgent) return;
    if (!removeConfirm) {
      setRemoveConfirm(true);
      return;
    }
    setSubmitState('checking');
    setError('');
    try {
      const response = await fetch('/api/collab/pty', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'roster_remove', channelId: channel.id, agentId: resultAgent.id }),
      });
      const data = await readJson(response);
      if (!response.ok || !data.success) {
        setSubmitState('partial');
        setError(data.error || 'Could not remove the roster entry.');
        return;
      }
      setAddedCount((count) => Math.max(0, count - 1));
      await refreshRoster();
      resetForAnother();
    } catch {
      setSubmitState('partial');
      setError('Could not remove the roster entry.');
    }
  };

  const characters = selectedRole ? roleCharacters(selectedRole) : [];
  const allCharactersUsed = (role: AgentRole) =>
    roleCharacters(role).length > 0 && roleCharacters(role).every((name) => usedNames.has(name.toLowerCase()));
  const showResult = submitState === 'success' || submitState === 'partial' || submitState === 'duplicate';

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-[#030812]/88 p-3 sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-agent-title"
        className="relative flex max-h-[94vh] w-full max-w-[860px] flex-col overflow-hidden rounded-[18px] border border-[#27466f]/55 bg-[#081321] shadow-[0_36px_120px_rgba(0,0,0,0.72),0_0_0_1px_rgba(59,130,246,0.05)]"
      >
        <div aria-hidden="true" className="absolute inset-x-0 top-0 h-[3px] bg-blue-500" />
        <header className="relative flex items-start justify-between overflow-hidden border-b border-[#28415f]/45 px-5 py-5 sm:px-7 sm:py-6">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 opacity-[0.12]"
            style={{
              backgroundImage: 'linear-gradient(rgba(96,165,250,.22) 1px, transparent 1px), linear-gradient(90deg, rgba(96,165,250,.22) 1px, transparent 1px)',
              backgroundSize: '28px 28px',
              maskImage: 'linear-gradient(90deg, black, transparent 72%)',
            }}
          />
          <div className="relative min-w-0">
            <div className="mb-2 flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-[0.22em] text-orange-300/80">
              <span className="h-1.5 w-1.5 bg-orange-400" /> New deployment
            </div>
            <div className="flex items-center gap-3">
              <UserPlus className="h-7 w-7 stroke-[1.7] text-blue-400" />
              <h2 id="add-agent-title" className="text-[clamp(1.45rem,3vw,2rem)] font-bold leading-none tracking-[-0.035em] text-[#edf5ff]">Add agent</h2>
              {addedCount > 0 && (
                <span className="border border-blue-400/25 bg-blue-500/10 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-blue-300">
                  {addedCount} added
                </span>
              )}
            </div>
            <p className="mt-2 text-sm text-[#9cafc6]">
              Assign a specialist, choose their runtime, launch.
            </p>
          </div>
          <div className="relative ml-6 hidden min-w-[210px] border-l border-[#35506f]/50 pl-5 sm:block">
            <div className="font-mono text-[9px] font-bold uppercase tracking-[0.2em] text-[#7890aa]">Deploying to</div>
            <div className="mt-1 text-sm font-semibold text-[#dce9f8]">{channel.name}</div>
            <div className="mt-1 max-w-[250px] truncate font-mono text-[10px] text-[#71859d]">
              {directory || 'Project directory required'}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close Add Agent"
            className="relative -mr-1 ml-4 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md border border-transparent text-[#71859d] transition-all hover:border-white/[0.08] hover:bg-white/[0.05] hover:text-[#dce9f8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-30"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="overflow-y-auto px-5 py-5 sm:px-7 sm:py-6">
          {showResult ? (
            <section tabIndex={-1} className="py-4 text-center">
              <div className={`mx-auto flex h-12 w-12 items-center justify-center rounded-full ${submitState === 'success' ? 'bg-emerald-500/12 text-emerald-400' : submitState === 'duplicate' ? 'bg-blue-500/12 text-blue-400' : 'bg-amber-500/12 text-amber-400'}`}>
                {submitState === 'success' ? <CheckCircle2 className="h-6 w-6" /> : <AlertTriangle className="h-6 w-6" />}
              </div>
              <h3 className="mt-4 text-lg font-semibold text-white/90">
                {submitState === 'success'
                  ? `${resultAgent?.name} is ready`
                  : submitState === 'duplicate'
                    ? `${resultAgent?.name || characterId} is already here`
                    : `${resultAgent?.name || characterId} was added, but could not start`}
              </h3>
              <p className="mx-auto mt-1 max-w-md text-sm text-white/45">
                {submitState === 'success'
                  ? `${selectedRole?.name || 'Agent'} · ${selectedModel?.label || 'Default model'} · ${resultStarted ? 'Running' : 'Stopped'}`
                  : error}
              </p>

              {submitState === 'partial' && resultAgent && (
                <div className="mx-auto mt-6 flex max-w-lg flex-wrap justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => startAgent(resultAgent)}
                    className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-[#3b82f6] px-4 py-2 text-sm font-semibold text-[#07111f] transition-colors hover:bg-[#60a5fa] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300"
                  >
                    <RotateCcw className="h-4 w-4" /> Retry start
                  </button>
                  <button
                    type="button"
                    onClick={() => { setResultStarted(false); setSubmitState('success'); setError(''); }}
                    className="min-h-11 rounded-lg border border-white/[0.09] px-4 py-2 text-sm text-white/65 hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300"
                  >
                    Keep stopped
                  </button>
                  <button
                    type="button"
                    onClick={removePartialAgent}
                    className={`inline-flex min-h-11 items-center gap-2 rounded-lg px-4 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 ${removeConfirm ? 'bg-red-500 text-white' : 'text-red-300 hover:bg-red-500/10'}`}
                  >
                    <Trash2 className="h-4 w-4" /> {removeConfirm ? 'Confirm remove' : 'Remove from roster'}
                  </button>
                </div>
              )}

              {(submitState === 'success' || submitState === 'duplicate') && (
                <div className="mx-auto mt-7 flex max-w-md flex-col gap-2 sm:flex-row">
                  <button
                    type="button"
                    onClick={resetForAnother}
                    className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-[#3b82f6] px-4 py-2.5 text-sm font-semibold text-[#07111f] transition-colors hover:bg-[#60a5fa] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300"
                  >
                    <Plus className="h-4 w-4" /> Add another agent
                  </button>
                  <button
                    type="button"
                    onClick={onClose}
                    className="min-h-11 rounded-lg border border-white/[0.09] px-5 py-2.5 text-sm font-medium text-white/65 transition-colors hover:bg-white/[0.05] hover:text-white/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300"
                  >
                    Done
                  </button>
                </div>
              )}
            </section>
          ) : (
            <div className="space-y-7">
              <section>
                <div className="mb-4 flex items-end justify-between gap-4">
                  <div className="flex items-end gap-3">
                    <span className="font-mono text-3xl font-black leading-none tracking-[-0.08em] text-blue-400">01</span>
                    <div>
                      <h3 className="text-base font-bold leading-none tracking-tight text-[#e7f0fb]">Choose a role</h3>
                      <p className="mt-1 text-[11px] text-[#71859d]">The role sets the recommended crew and runtime.</p>
                    </div>
                  </div>
                  <span className="hidden font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-[#526981] sm:block">{orderedRoles.length} specialties</span>
                </div>
                <div role="radiogroup" aria-label="Agent role" className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                  {orderedRoles.map((role, index) => {
                    const selected = role.id === roleId;
                    const unavailable = allCharactersUsed(role);
                    const visual = ROLE_VISUALS[role.slug] || { icon: UserPlus, code: 'AGT' };
                    const RoleIcon = visual.icon;
                    return (
                      <button
                        key={role.id}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        disabled={busy}
                        data-autofocus={index === 0 ? '' : undefined}
                        onClick={() => chooseRole(role)}
                        className={`group relative min-h-[82px] overflow-hidden rounded-lg border px-3.5 py-3 text-left transition-[transform,border-color,background-color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${selected ? 'border-[#60a5fa] bg-[#3b82f6] text-[#06101e] shadow-[0_10px_30px_rgba(37,99,235,0.3)]' : unavailable ? 'border-[#1b2b40] bg-[#0a1524] text-[#526278]' : 'border-[#21364f] bg-[#0d1a2b] text-[#c8d5e5] hover:-translate-y-0.5 hover:border-[#3c608b] hover:bg-[#112238]'} disabled:cursor-not-allowed`}
                      >
                        <span aria-hidden="true" className={`absolute -bottom-3 right-1 font-mono text-[44px] font-black leading-none tracking-[-0.12em] ${selected ? 'text-[#06101e]/10' : 'text-[#8bbcff]/[0.035]'}`}>
                          {String(index + 1).padStart(2, '0')}
                        </span>
                        {unavailable && (
                          <span aria-hidden="true" className="absolute inset-0 opacity-[0.04]" style={{ backgroundImage: 'repeating-linear-gradient(-45deg, transparent, transparent 6px, white 6px, white 7px)' }} />
                        )}
                        <span className="relative flex items-center justify-between gap-2">
                          <RoleIcon className={`h-[18px] w-[18px] stroke-[1.8] ${selected ? 'text-[#071322]' : unavailable ? 'text-[#526278]' : 'text-blue-400'}`} />
                          <span className={`font-mono text-[9px] font-black tracking-[0.16em] ${selected ? 'text-[#071322]/60' : unavailable ? 'text-[#46566b]' : 'text-orange-300/60'}`}>{visual.code}</span>
                        </span>
                        <span className={`relative mt-2 block text-sm font-bold tracking-[-0.01em] ${selected ? 'text-[#06101e]' : ''}`}>{role.name}</span>
                        <span className={`relative mt-0.5 block truncate text-[10px] ${selected ? 'text-[#06101e]/58' : unavailable ? 'text-[#46566b]' : 'text-[#71859d]'}`}>
                          {unavailable ? 'All in use · add a new character' : roleCharacters(role).join(' · ')}
                        </span>
                        {selected && <Check className="absolute bottom-3 right-3 h-4 w-4 stroke-[3] text-[#06101e]" />}
                      </button>
                    );
                  })}
                </div>
              </section>

              {selectedRole && (
                <section className="animate-in fade-in slide-in-from-top-1 duration-150">
                  <div className="mb-3 flex items-end gap-3 border-t border-[#21364f]/70 pt-5">
                    <span className="font-mono text-2xl font-black leading-none tracking-[-0.08em] text-blue-400">02</span>
                    <div>
                      <h3 className="text-sm font-bold leading-none text-[#e7f0fb]">Assign a character</h3>
                      <p className="mt-1 text-[10px] text-[#71859d]">Personality and identity for this specialist.</p>
                    </div>
                  </div>
                  <div role="radiogroup" aria-label="Character" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {characters.map((name) => {
                      const used = usedNames.has(name.toLowerCase());
                      const selected = characterId === name;
                      return (
                        <button
                          key={name}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          disabled={used || busy}
                          onClick={() => { setCharacterId(name); setError(''); }}
                          className={`relative min-h-[54px] rounded-lg border px-3.5 py-2.5 text-left text-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${selected ? 'border-blue-400 bg-[#16345c] text-[#eff6ff] shadow-[inset_3px_0_0_#60a5fa]' : 'border-[#21364f] bg-[#0d1a2b] text-[#b9c8da] hover:border-[#3c608b] hover:bg-[#112238]'} disabled:cursor-not-allowed disabled:opacity-40`}
                        >
                          <span className="flex items-center justify-between gap-2 font-medium">
                            {name}
                            {selected && <Check className="h-3.5 w-3.5 text-blue-300" />}
                          </span>
                          {used && <span className="mt-0.5 block text-[10px] text-white/38">Already in this channel</span>}
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      disabled={busy || inventing}
                      onClick={() => inventCharacter(selectedRole)}
                      className="relative min-h-[54px] rounded-lg border border-dashed border-[#3c608b] bg-[#0a1524] px-3.5 py-2.5 text-left text-sm text-[#b9c8da] transition-all hover:border-blue-400 hover:bg-[#112238] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <span className="flex items-center gap-2 font-medium">
                        {inventing ? <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-300" /> : <Plus className="h-3.5 w-3.5 text-blue-300" />}
                        {inventing ? 'Finding a character…' : 'New character'}
                      </span>
                      <span className="mt-0.5 block text-[10px] text-white/38">A sci-fi character suited to this role</span>
                    </button>
                  </div>
                </section>
              )}

              {selectedRole && characterId && (
                <section className="animate-in fade-in slide-in-from-top-1 duration-150">
                  <div className="mb-3 flex items-end gap-3 border-t border-[#21364f]/70 pt-5">
                    <span className="font-mono text-2xl font-black leading-none tracking-[-0.08em] text-blue-400">03</span>
                    <div>
                      <h3 className="text-sm font-bold leading-none text-[#e7f0fb]">Configure runtime</h3>
                      <p className="mt-1 text-[10px] text-[#71859d]">Recommended settings are already loaded.</p>
                    </div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block">
                      <span className="mb-1.5 block text-[11px] font-medium text-white/45">Model</span>
                      <select
                        value={modelId}
                        disabled={busy}
                        onChange={(event) => {
                          setModelId(event.target.value);
                          setHarnessOverride('');
                          setEffort('');
                          setSpawnMode('wsl');
                        }}
                        className="min-h-11 w-full rounded-lg border border-[#294766] bg-[#07111e] px-3 text-sm text-[#dce9f8] focus:outline-none focus:ring-2 focus:ring-blue-400/60"
                      >
                        <option value="" className="bg-[#0a1425]">Role default</option>
                        {modelRegistry.map((model) => (
                          <option key={model.id} value={model.id} className="bg-[#0a1425]">
                            {model.label}
                          </option>
                        ))}
                      </select>
                    </label>

                    {availableEfforts.length > 0 && (
                      <label className="block">
                        <span className="mb-1.5 block text-[11px] font-medium text-white/45">Effort</span>
                        <select
                          value={effort}
                          disabled={busy}
                          onChange={(event) => setEffort(event.target.value as EffortLevel)}
                          className="min-h-11 w-full rounded-lg border border-[#294766] bg-[#07111e] px-3 text-sm capitalize text-[#dce9f8] focus:outline-none focus:ring-2 focus:ring-blue-400/60"
                        >
                          <option value="" className="bg-[#0a1425]">Inherit default</option>
                          {availableEfforts.map((level) => <option key={level} value={level} className="bg-[#0a1425]">{level}</option>)}
                        </select>
                      </label>
                    )}
                  </div>
                  <HarnessLoginNotice harness={agentType} onLaptop={onLaptop} />

                  <div className="mt-3">
                    <span className="mb-1.5 block text-[11px] font-medium text-white/45">Where it runs</span>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Where it runs">
                      <button
                        type="button"
                        role="radio"
                        aria-checked={!onLaptop}
                        onClick={() => setOnLaptop(false)}
                        disabled={busy}
                        className={`min-h-12 rounded-lg border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-45 ${!onLaptop ? 'border-emerald-400/55 bg-emerald-500/[0.08] shadow-[inset_3px_0_0_#34d399]' : 'border-[#21364f] bg-[#0d1a2b] hover:border-[#3c608b] hover:bg-[#112238]'}`}
                      >
                        <span className="flex items-center gap-2 text-sm font-medium text-white/78"><Monitor className="h-4 w-4 text-emerald-400" /> Run locally</span>
                        <span className="mt-0.5 block text-[10px] text-white/35">On your desktop</span>
                      </button>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={onLaptop}
                        onClick={() => { setOnLaptop(true); setSpawnMode('wsl'); }}
                        disabled={!laptop.ready || busy}
                        title={laptop.ready ? laptopTooltip(laptop.mode) : laptop.reason}
                        className={`min-h-12 rounded-lg border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-45 ${onLaptop ? 'border-violet-400/55 bg-violet-500/[0.09] shadow-[inset_3px_0_0_#a78bfa]' : 'border-[#21364f] bg-[#0d1a2b] hover:border-[#3c608b] hover:bg-[#112238]'}`}
                      >
                        <span className="flex items-center gap-2 text-sm font-medium text-white/78"><Server className="h-4 w-4 text-violet-300" /> Run remote</span>
                        <span className="mt-0.5 block text-[10px] text-white/35">{laptop.ready ? 'On the remote server' : 'Not ready yet'}</span>
                      </button>
                    </div>
                    {!laptop.ready && !laptop.loading && laptop.failingCheckId === 'signed-in' && (
                      <button type="button" onClick={() => setShowLogins(true)} className="mt-1.5 text-xs text-sky-300 underline hover:text-sky-200">Sign in on the remote server</button>
                    )}
                    {showLogins && <LoginsDialog onClose={() => setShowLogins(false)} />}
                  </div>

                  {!onLaptop && agentType === 'claude' && (
                    <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Execution environment">
                      <button
                        type="button"
                        role="radio"
                        aria-checked={spawnMode === 'wsl'}
                        onClick={() => setSpawnMode('wsl')}
                        className={`min-h-12 rounded-lg border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${spawnMode === 'wsl' ? 'border-emerald-400/55 bg-emerald-500/[0.08] shadow-[inset_3px_0_0_#34d399]' : 'border-[#21364f] bg-[#0d1a2b] hover:border-[#3c608b] hover:bg-[#112238]'}`}
                      >
                        <span className="flex items-center gap-2 text-sm font-medium text-white/78"><Terminal className="h-4 w-4 text-emerald-400" /> WSL</span>
                        <span className="mt-0.5 block text-[10px] text-white/35">Persistent terminal</span>
                      </button>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={spawnMode === 'powershell'}
                        onClick={() => setSpawnMode('powershell')}
                        disabled={!!powershellUnavailable}
                        title={powershellUnavailable || undefined}
                        className={`min-h-12 rounded-lg border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-45 ${spawnMode === 'powershell' ? 'border-blue-400/55 bg-blue-500/[0.09] shadow-[inset_3px_0_0_#60a5fa]' : 'border-[#21364f] bg-[#0d1a2b] hover:border-[#3c608b] hover:bg-[#112238]'}`}
                      >
                        <span className="flex items-center gap-2 text-sm font-medium text-white/78"><Terminal className="h-4 w-4 text-blue-400" /> PowerShell</span>
                        <span className="mt-0.5 block text-[10px] text-white/35">{powershellUnavailable ? `Unavailable while ${PRODUCT_NAME} runs on the server` : 'Per-message · no persistent terminal'}</span>
                      </button>
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => setAdvancedOpen((open) => !open)}
                    aria-expanded={advancedOpen}
                    className="mt-3 inline-flex min-h-11 items-center gap-1.5 text-xs font-medium text-white/38 transition-colors hover:text-white/65 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                  >
                    <ChevronDown className={`h-3.5 w-3.5 transition-transform ${advancedOpen ? 'rotate-180' : ''}`} /> Advanced
                  </button>
                  {advancedOpen && (
                    <div className="grid gap-3 rounded-lg border border-white/[0.06] bg-black/15 p-3 sm:grid-cols-2">
                      <div>
                        <span className="mb-1.5 block text-[11px] font-medium text-white/45">Project directory</span>
                        <DirectoryAutocomplete
                          value={directory}
                          onChange={(value) => { setDirectory(value); setError(''); }}
                          className="min-h-10 flex-1 rounded-lg border border-white/[0.09] bg-black/25 px-2 text-xs text-white/75 focus:outline-none focus:ring-2 focus:ring-blue-400/60"
                          iconClassName="h-3.5 w-3.5 flex-shrink-0 text-amber-400/65"
                        />
                      </div>
                      <div>
                        <span className="mb-1.5 block text-[11px] font-medium text-white/45">Harness</span>
                        {harnesses.length > 1 ? (
                          <select
                            value={agentType}
                            onChange={(event) => { setHarnessOverride(event.target.value); setEffort(''); setSpawnMode('wsl'); }}
                            className="min-h-10 w-full rounded-lg border border-white/[0.09] bg-black/25 px-2 text-xs text-white/75 focus:outline-none focus:ring-2 focus:ring-blue-400/60"
                          >
                            {harnesses.map((harness) => <option key={harness} value={harness} className="bg-[#0a1425]">{HARNESS_LABELS[harness] || harness}</option>)}
                          </select>
                        ) : (
                          <div className="flex min-h-10 items-center rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 text-xs text-white/48">
                            Runs via {HARNESS_LABELS[agentType] || agentType}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </section>
              )}

              <div aria-live="assertive" className="min-h-5">
                {error && <p className="rounded-lg border border-red-500/15 bg-red-500/[0.06] px-3 py-2 text-xs text-red-300">{error}</p>}
              </div>
            </div>
          )}
        </div>

        {!showResult && (
          <footer className="flex items-center justify-between gap-3 border-t border-[#28415f]/45 bg-[#06101d] px-5 py-4 sm:px-7">
            <div role="status" aria-live="polite" className="text-xs text-white/38">
              {busy ? (
                <span className="inline-flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400" /> {progressLabel(submitState)}</span>
              ) : selectedRole && characterId ? (
                <span>{selectedRole.name} · {characterId} · {HARNESS_LABELS[agentType] || agentType}</span>
              ) : 'Choose a role to begin'}
            </div>
            <button
              type="button"
              onClick={addAndStart}
              disabled={busy || !selectedRole || !characterId || !directory.trim()}
              className="group inline-flex min-h-11 flex-shrink-0 items-center gap-2 rounded-lg bg-[#3b82f6] px-5 py-2.5 text-sm font-black tracking-[-0.01em] text-[#06101d] shadow-[0_8px_24px_rgba(37,99,235,0.25)] transition-all hover:-translate-y-0.5 hover:bg-[#60a5fa] hover:shadow-[0_12px_30px_rgba(37,99,235,0.34)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300 disabled:cursor-not-allowed disabled:opacity-35 disabled:shadow-none disabled:hover:translate-y-0"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
              Add &amp; start
            </button>
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}
