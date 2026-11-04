'use client';

/**
 * Says so when an agent that was asked something has not answered after 45 seconds. Without it a stuck agent (usually waiting at a sign-in or
 * folder-trust prompt in its own terminal) looks "Ready" and the person is left guessing. It names the command that shows the agent's screen.
 * One timer, set for the next agent about to be overdue: no polling.
 */

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Copy, Check, X } from 'lucide-react';
import { findSilentAgents, type SilentAgent, type SilentMessage, type SilentParticipant, type SilentRosterAgent } from '@/lib/silent-agents';

interface Props {
  messages: SilentMessage[];
  roster: SilentRosterAgent[];
  participants: SilentParticipant[];
}

/** Asks the server for the command, because it depends on whether the app runs inside a container. Falls back to the plain form. */
function useAttachCommand(session: string | undefined): string | undefined {
  const [command, setCommand] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!session) return;
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/collab/attach-command?session=${encodeURIComponent(session)}`, { cache: 'no-store' });
        const json = await res.json();
        if (alive) setCommand(res.ok && typeof json.command === 'string' ? json.command : `tmux attach -t ${session}`);
      } catch {
        if (alive) setCommand(`tmux attach -t ${session}`);
      }
    })();
    return () => { alive = false; };
  }, [session]);
  return session ? command : undefined;
}

function SilentAgentCard({ agent, copied, onCopy, onDismiss }: { agent: SilentAgent; copied: string | null; onCopy: (c: string) => void; onDismiss: () => void }) {
  const command = useAttachCommand(agent.tmuxSession);
  return (
    <div role="status" className="rounded-xl border border-yellow-400/30 bg-yellow-400/10 p-3 text-sm text-yellow-100">
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0 text-yellow-300" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{agent.name} has not answered in 45 seconds.</p>
          <p className="mt-1 text-yellow-100/80">
            The roster can show Ready while an agent is stuck. The usual cause is that its terminal is waiting for you at a sign-in or a trust question,
            or that no AI is signed in on this computer.
            {agent.tmuxSession ? ' To see what it is waiting for, run this in a terminal:' : ' Check that the AI you chose is installed and signed in.'}
          </p>
          {command && (
            <div className="mt-2 flex items-center gap-2">
              <code className="rounded-md bg-black/30 px-2 py-1 text-xs break-all">{command}</code>
              <button
                type="button"
                onClick={() => onCopy(command)}
                className="inline-flex items-center gap-1 rounded-md border border-yellow-300/40 px-2 py-1 text-xs hover:bg-yellow-300/10 min-h-8"
              >
                {copied === command ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5" aria-hidden="true" />}
                {copied === command ? 'Copied' : 'Copy'}
              </button>
            </div>
          )}
          {command && <p className="mt-2 text-xs text-yellow-100/60">Press Ctrl+B then D to leave it running when you are done.</p>}
        </div>
        <button type="button" onClick={onDismiss} aria-label={`Dismiss the note about ${agent.name}`} className="p-1 rounded hover:bg-yellow-300/10">
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export function SilentAgentNotice({ messages, roster, participants }: Props) {
  const [now, setNow] = useState(() => Date.now());
  const [dismissed, setDismissed] = useState<Record<string, number>>({});
  const [copied, setCopied] = useState<string | null>(null);

  const { silent, pending } = useMemo(
    () => findSilentAgents({ messages, roster, participants, now }),
    [messages, roster, participants, now],
  );

  // Wake once, at the moment the next asked agent becomes overdue.
  useEffect(() => {
    if (pending.length === 0) return;
    const next = Math.min(...pending.map((p) => p.dueAt));
    const timer = setTimeout(() => setNow(Date.now()), Math.max(next - Date.now(), 0) + 50);
    return () => clearTimeout(timer);
  }, [pending]);

  const shown = silent.filter((s) => dismissed[s.participantId] !== s.askedAt);
  if (shown.length === 0) return null;

  const copy = async (command: string) => {
    try { await navigator.clipboard.writeText(command); setCopied(command); } catch { /* the command is shown, so it can be selected by hand */ }
  };

  return (
    <div className="mx-4 my-3 flex flex-col gap-2" data-testid="silent-agents">
      {shown.map((agent) => (
        <SilentAgentCard
          key={agent.participantId}
          agent={agent}
          copied={copied}
          onCopy={(c) => void copy(c)}
          onDismiss={() => setDismissed((d) => ({ ...d, [agent.participantId]: agent.askedAt }))}
        />
      ))}
    </div>
  );
}
