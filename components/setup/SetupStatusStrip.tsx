'use client';

/**
 * "What is set up" for the Setup channel: one line of chips above Jack's messages. It reads GET /api/setup/summary (the same records the
 * wizards write, no secrets) and draws nothing in any channel except the Setup channel. It reads once when the channel opens and again
 * when the browser tab regains focus, so it is current after the user has been to a wizard card, without polling.
 */

import { useEffect, useState } from 'react';
import { CheckCircle2, Circle, MinusCircle } from 'lucide-react';

type State = 'on' | 'off' | 'skipped';
interface Item { id: string; label: string; state: State }
interface Summary { items: Item[]; setupChannelId: string | null }

const STATE_TEXT: Record<State, string> = { on: 'On', off: 'Not set up', skipped: 'Skipped' };

const QUICK_STARTS = [
  'What can OpenFlow connect to?',
  'What is already set up?',
  'Help me set up shared memory',
] as const;

export function SetupStatusStrip({ channelId, participantId }: { channelId: string; participantId?: string | null }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [sendError, setSendError] = useState(false);

  // Sends the question as an ordinary message from the person, addressed to Jack.
  const ask = async (question: string) => {
    if (!participantId) return;
    setSendError(false);
    try {
      const res = await fetch('/api/collab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'message', channelId, participantId, content: `@Jack ${question}` }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.success === false) throw new Error('not sent');
      setSent(question);
    } catch {
      setSendError(true);
    }
  };

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch('/api/setup/summary', { cache: 'no-store' });
        const json = await res.json();
        if (alive && res.ok && json.success && Array.isArray(json.items)) setSummary({ items: json.items as Item[], setupChannelId: json.setupChannelId ?? null });
      } catch { /* the strip is optional: no strip is better than a broken one */ }
    };
    void load();
    const onFocus = () => { void load(); };
    window.addEventListener('focus', onFocus);
    return () => { alive = false; window.removeEventListener('focus', onFocus); };
  }, []);

  if (!summary || summary.setupChannelId !== channelId) return null;

  return (
    <div className="setup-strip" data-testid="setup-status-strip">
      <p className="ss-note">What is set up. Ask Jack about anything marked Not set up.</p>
      <ul className="ss-chips" aria-label="What is set up">
        {summary.items.map((item) => {
          const Icon = item.state === 'on' ? CheckCircle2 : item.state === 'skipped' ? MinusCircle : Circle;
          return (
            <li key={item.id} className={`ss-chip ss-chip--${item.state}`}>
              <Icon className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{item.label}</span>
              <span className="sr-only">: </span>
              <span className="ss-chip-state">{STATE_TEXT[item.state]}</span>
            </li>
          );
        })}
      </ul>

      {participantId && (
        <div className="ss-ask" data-testid="quick-starts">
          <p className="ss-note">Ask Jack:</p>
          <div className="ss-buttons">
            {QUICK_STARTS.map((q) => (
              <button key={q} type="button" onClick={() => void ask(q)} className="ss-button">
                {q}
              </button>
            ))}
          </div>
          {sendError && <p role="alert" className="ss-error">That did not send. Try again, or type your question below.</p>}
          {sent && !sendError && <p role="status" className="ss-note">Sent. Jack will answer in a moment.</p>}
        </div>
      )}
      <a href="/operations#systems/connections" className="ss-link">
        Open Systems &gt; Connections
      </a>
    </div>
  );
}
