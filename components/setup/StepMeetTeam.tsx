'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Users, Loader2, CheckCircle, AlertTriangle, Send } from 'lucide-react';
import { HUMAN_ROUTING_NAME } from '@/lib/human-identity';
import { PRODUCT_NAME } from '@/lib/brand';
import { SetupSelect } from '@/components/setup/SetupSelect';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ExampleAgent {
  name: string;
  roleSlug: string;
  summary: string;
  firstMessage: string;
  /** Ticked when the step opens (the server sends false for agents that are only offered). */
  default?: boolean;
}

interface AgentResult {
  name: string;
  started: boolean;
  error?: string;
}

interface ChannelMessage {
  id: string;
  from: { id: string; name: string; type: string };
  content: string;
}

type Phase = 'choose' | 'starting' | 'waiting' | 'done' | 'failed';

interface StepMeetTeamProps {
  /** Called once the user is done: completes setup and leaves the wizard. */
  onFinish: (channelId: string | null) => void;
}

const RUNTIMES: { value: string; label: string; hint: string }[] = [
  { value: 'claude', label: 'Claude', hint: 'Uses the Claude sign-in or API key on this machine.' },
  { value: 'codex', label: 'Codex', hint: 'Uses the Codex sign-in or API key on this machine.' },
  { value: 'antigravity', label: 'Gemini (Antigravity)', hint: 'Uses the Antigravity sign-in (a Google account) on this machine.' },
  { value: 'grok', label: 'Grok', hint: 'Uses the Grok API key on this machine.' },
];

// How long to wait for a reply before explaining what to check (agents take a
// while to sign in and read their rules the first time they start).
const REPLY_TIMEOUT_MS = 240_000;
const POLL_MS = 2_500;

function browserParticipantId(): string {
  const key = 'devflow-collab-participant-id';
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const id = `browser-user-${Date.now().toString(36)}`;
    localStorage.setItem(key, id);
    return id;
  } catch {
    return `browser-user-${Date.now().toString(36)}`;
  }
}

async function postCollab(body: Record<string, unknown>): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const res = await fetch('/api/collab', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok && data.success !== false, data };
}

// ─── Component ───────────────────────────────────────────────────────────────

export function StepMeetTeam({ onFinish }: StepMeetTeamProps) {
  const [agents, setAgents] = useState<ExampleAgent[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loadError, setLoadError] = useState('');
  const [runtimeInfo, setRuntimeInfo] = useState<Record<string, { installed: boolean | null; install?: string }>>({});
  const [runtime, setRuntime] = useState('claude');
  const [folder, setFolder] = useState('');
  const [phase, setPhase] = useState<Phase>('choose');
  const [error, setError] = useState('');
  const [results, setResults] = useState<AgentResult[]>([]);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChannelMessage[]>([]);
  const [started, setStarted] = useState<string[]>([]);
  const stopRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/setup/first-team')
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        if (!json.success) {
          setLoadError(json.error || 'Could not load the example agents.');
          return;
        }
        setAgents(json.agents);
        setRuntimeInfo(json.runtimes ?? {});
        // The agents marked as defaults start ticked; the rest are offered.
        setSelected(new Set(json.agents.filter((a: ExampleAgent) => a.default !== false).map((a: ExampleAgent) => a.name)));
        setFolder(json.defaultWorkingDirectory || '');
      })
      .catch(() => !cancelled && setLoadError(`Could not reach ${PRODUCT_NAME} to load the example agents.`));
    return () => {
      cancelled = true;
      stopRef.current = true;
    };
  }, []);

  const toggle = (name: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  // Poll the channel until every started agent has answered, or time runs out.
  const watchForReplies = useCallback(async (id: string, names: string[]) => {
    const deadline = Date.now() + REPLY_TIMEOUT_MS;
    while (!stopRef.current && Date.now() < deadline) {
      try {
        const res = await fetch(`/api/collab?channelId=${encodeURIComponent(id)}&limit=50`);
        const json = await res.json();
        const msgs: ChannelMessage[] = json?.channels?.[0]?.messages ?? [];
        setMessages(msgs);
        const answered = names.every((n) => msgs.some((m) => m.from?.name === n && m.from?.type !== 'user'));
        if (answered) {
          setPhase('done');
          return;
        }
      } catch {
        /* keep polling; a single failed poll is not a failed start */
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    if (!stopRef.current) setPhase('failed');
  }, []);

  const start = async () => {
    setError('');
    setPhase('starting');
    try {
      // Store the keys from the AI access step first: agents read them when they start, so they must be in place before the team is.
      // Safe to repeat; "Finish setup" calls it again.
      const prep = await fetch('/api/setup/complete', { method: 'POST' });
      const prepJson = await prep.json().catch(() => ({}));
      if (!prep.ok || prepJson.success === false) {
        setError(prepJson.error || 'Could not save your settings before starting the team.');
        setPhase('choose');
        return;
      }
      const res = await fetch('/api/setup/first-team', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agents: [...selected],
          agentType: runtime,
          workingDirectory: folder.trim() || undefined,
          channelId: channelId || undefined,
        }),
      });
      const json = await res.json();
      if (json.channelId) setChannelId(json.channelId);
      if (json.agents) setResults(json.agents);
      if (!json.success) {
        setError(json.error || 'None of the agents could start.');
        setPhase('choose');
        return;
      }
      const up: string[] = (json.agents as AgentResult[]).filter((a) => a.started).map((a) => a.name);
      setStarted(up);

      // Join as the person and send each started agent its first message.
      const participantId = browserParticipantId();
      const join = await postCollab({
        action: 'join',
        channelId: json.channelId,
        participant: { id: participantId, type: 'user', name: HUMAN_ROUTING_NAME, source: 'DevFlow Browser' },
      });
      if (!join.ok) throw new Error(String(join.data.error || 'Could not join the channel'));
      const joinedId = (join.data.participantId as string) || participantId;
      for (const name of up) {
        const text = json.firstMessages?.[name] as string | undefined;
        if (!text) continue;
        const sent = await postCollab({
          action: 'message',
          channelId: json.channelId,
          participantId: joinedId,
          content: `@${name} ${text}`,
        });
        if (!sent.ok) throw new Error(String(sent.data.error || `Could not message ${name}`));
      }
      setPhase('waiting');
      void watchForReplies(json.channelId, up);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong while starting the team.');
      setPhase('choose');
    }
  };

  const failedAgents = results.filter((a) => !a.started);
  const replies = messages.filter((m) => m.from?.type !== 'user' && started.includes(m.from?.name));

  return (
    <div className="glass-card p-8 relative z-10">
      <div className="flex items-center gap-4 mb-6">
        <div
          className="flex-shrink-0 p-3 rounded-xl"
          style={{
            background: 'rgba(59, 130, 246, 0.12)',
            border: '1px solid rgba(59, 130, 246, 0.25)',
          }}
        >
          <Users className="w-6 h-6 text-[#60a5fa]" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-white leading-tight">Meet your team</h2>
          <p className="text-sm text-white/40 mt-0.5">
            Start your team, say hello, and see them answer. You can rename them and change their personalities later.
          </p>
        </div>
      </div>

      {loadError && (
        <p className="text-sm text-red-400 flex items-start gap-2" role="alert">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" /> {loadError}
        </p>
      )}

      {(phase === 'choose' || phase === 'starting') && !loadError && (
        <div className="flex flex-col gap-5">
          <fieldset className="flex flex-col gap-2" disabled={phase === 'starting'}>
            <legend className="text-sm text-white/60 font-medium mb-1">Who to start</legend>
            {agents.map((a) => (
              <label
                key={a.name}
                className="flex items-start gap-3 p-3 rounded-xl cursor-pointer border border-white/10 bg-white/[0.03] hover:bg-white/[0.06]"
              >
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={selected.has(a.name)}
                  onChange={() => toggle(a.name)}
                />
                <span>
                  <span className="block text-sm font-medium text-white">{a.name}</span>
                  <span className="block text-xs text-white/50 mt-0.5">{a.summary}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="team-runtime" className="text-sm text-white/60 font-medium">AI to run them on</label>
            <SetupSelect
              id="team-runtime"
              value={runtime}
              options={RUNTIMES.map((r) => ({ value: r.value, label: r.label }))}
              disabled={phase === 'starting'}
              onChange={setRuntime}
            />
            <p className="text-xs text-white/40">{RUNTIMES.find((r) => r.value === runtime)?.hint}</p>
            {runtimeInfo[runtime]?.installed === false && (
              <p className="text-xs text-yellow-300" role="status">
                {RUNTIMES.find((r) => r.value === runtime)?.label} is not installed on this machine. Install it first
                {runtimeInfo[runtime]?.install ? <>: <code className="text-yellow-200">{runtimeInfo[runtime]?.install}</code>.</> : '.'}
                {' '}Then start the team.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="team-folder" className="text-sm text-white/60 font-medium">Project folder</label>
            <input
              id="team-folder"
              type="text"
              className="glass-input"
              value={folder}
              disabled={phase === 'starting'}
              onChange={(e) => setFolder(e.target.value)}
            />
            <p className="text-xs text-white/40">The agents work here. It is created if it does not exist.</p>
          </div>

          {error && (
            <p className="text-sm text-red-400 flex items-start gap-2" role="alert">
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" /> {error}
            </p>
          )}
          {failedAgents.length > 0 && (
            <ul className="text-xs text-red-400 list-disc pl-5">
              {failedAgents.map((a) => <li key={a.name}>{a.name}: {a.error || 'did not start'}</li>)}
            </ul>
          )}

          <button
            onClick={start}
            disabled={phase === 'starting' || selected.size === 0}
            className="glass-button primary flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-medium text-white disabled:opacity-60"
          >
            {phase === 'starting' ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Starting your team…</>
            ) : (
              <><Send className="w-4 h-4" /> {failedAgents.length > 0 ? 'Try again' : 'Start my team and say hello'}</>
            )}
          </button>
        </div>
      )}

      {(phase === 'waiting' || phase === 'done' || phase === 'failed') && (
        <div className="flex flex-col gap-4" aria-live="polite">
          <ul className="flex flex-col gap-3">
            {started.map((name) => {
              const reply = replies.filter((m) => m.from.name === name).slice(-1)[0];
              return (
                <li key={name} className="p-3 rounded-xl border border-white/10 bg-white/[0.03]">
                  <div className="flex items-center gap-2 text-sm font-medium text-white">
                    {reply ? (
                      <CheckCircle className="w-4 h-4 text-green-400" />
                    ) : phase === 'failed' ? (
                      <AlertTriangle className="w-4 h-4 text-yellow-400" />
                    ) : (
                      <Loader2 className="w-4 h-4 animate-spin text-white/50" />
                    )}
                    {name}
                  </div>
                  <p className="text-sm text-white/70 mt-2 whitespace-pre-wrap">
                    {reply ? reply.content : phase === 'failed' ? 'No reply yet.' : 'Starting up. The first reply can take a minute.'}
                  </p>
                </li>
              );
            })}
          </ul>

          {failedAgents.length > 0 && (
            <ul className="text-xs text-yellow-300 list-disc pl-5">
              {failedAgents.map((a) => (
                <li key={a.name}>{a.name} did not start: {a.error || 'unknown reason'}. You can add it again from the roster once that is fixed.</li>
              ))}
            </ul>
          )}

          {phase === 'failed' && (
            <p className="text-sm text-yellow-300">
              The agents started but have not answered yet. Check that the {RUNTIMES.find((r) => r.value === runtime)?.label} sign-in
              or API key works on this machine. You can carry on; the replies will appear in the channel when they arrive.
            </p>
          )}

          <button
            onClick={() => onFinish(channelId)}
            className="glass-button primary flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-medium text-white"
          >
            {phase === 'done' ? 'Finish setup' : 'Continue to the dashboard'}
          </button>
        </div>
      )}
    </div>
  );
}
