/**
 * Which agents were asked something and have not answered?
 *
 * An agent that started but is stuck (most often at a sign-in or folder-trust prompt in its terminal) looks "Ready" in the roster and stays
 * silent. The person gets no clue. This finds those agents from what the channel already holds, so the chat can say so after a short wait.
 * Pure: no clock, no network. The caller passes the time.
 */

export const SILENT_AFTER_MS = 45_000;
/** Older questions are not worth raising: the person has moved on. */
const FORGET_AFTER_MS = 15 * 60_000;

export interface SilentMessage {
  id: string;
  from: { id: string; type?: string };
  content: string;
  timestamp: string;
  recipients?: string[];
  mentions?: string[];
}

export interface SilentRosterAgent {
  name: string;
  participantId: string;
  tmuxSessionName?: string;
  status?: string;
}

export interface SilentParticipant {
  id: string;
  activityStatus?: string;
}

export interface SilentAgent {
  name: string;
  participantId: string;
  /** The agent's tmux session, when it has a plain one. The command to attach comes from the server (it depends on where the app runs). */
  tmuxSession?: string;
  askedAt: number;
  /** Time at which this agent becomes "silent", for scheduling one timer. */
  dueAt: number;
}

const SAFE_SESSION = /^[A-Za-z0-9._:-]{1,120}$/;

/** The session name when it is a plain tmux name, otherwise nothing. */
export function plainSession(tmuxSessionName: string | undefined): string | undefined {
  return tmuxSessionName && SAFE_SESSION.test(tmuxSessionName) ? tmuxSessionName : undefined;
}

function isAddressedTo(msg: SilentMessage, agent: SilentRosterAgent): boolean {
  if (msg.recipients?.includes(agent.participantId) || msg.mentions?.includes(agent.participantId)) return true;
  const escaped = agent.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)@${escaped}(?![\\w-])`, 'i').test(msg.content);
}

/**
 * For each running agent: take the person's latest message addressed to it. It is silent when nothing from that agent came after it, the
 * message is at least `afterMs` old (and under 15 minutes), and the agent is not shown as busy.
 * `pending` are agents asked recently that may become silent; `silent` are the ones to warn about now.
 */
export function findSilentAgents(input: {
  messages: SilentMessage[];
  roster: SilentRosterAgent[];
  participants: SilentParticipant[];
  now: number;
  afterMs?: number;
}): { silent: SilentAgent[]; pending: SilentAgent[] } {
  const afterMs = input.afterMs ?? SILENT_AFTER_MS;
  const silent: SilentAgent[] = [];
  const pending: SilentAgent[] = [];
  const times = input.messages.map((m) => ({ m, t: Date.parse(m.timestamp) })).filter((x) => Number.isFinite(x.t));

  for (const agent of input.roster) {
    if (agent.status && agent.status !== 'running') continue;
    const asked = times.filter(({ m }) => m.from.type === 'user' && isAddressedTo(m, agent)).sort((a, b) => b.t - a.t)[0];
    if (!asked) continue;
    const answered = times.some(({ m, t }) => m.from.id === agent.participantId && t >= asked.t);
    if (answered) continue;
    const age = input.now - asked.t;
    if (age > FORGET_AFTER_MS) continue;
    const busy = input.participants.find((p) => p.id === agent.participantId)?.activityStatus;
    if (busy === 'working' || busy === 'typing') continue;
    const entry: SilentAgent = {
      name: agent.name,
      participantId: agent.participantId,
      tmuxSession: plainSession(agent.tmuxSessionName),
      askedAt: asked.t,
      dueAt: asked.t + afterMs,
    };
    (age >= afterMs ? silent : pending).push(entry);
  }
  return { silent, pending };
}
