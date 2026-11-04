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

export function SetupStatusStrip({ channelId }: { channelId: string }) {
  const [summary, setSummary] = useState<Summary | null>(null);

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
    <div className="px-4 py-3 border-b border-white/10" data-testid="setup-status-strip">
      <p className="text-xs text-white/50 mb-2">What is set up. Ask Jack about anything marked Not set up.</p>
      <ul className="flex flex-wrap gap-2" aria-label="What is set up">
        {summary.items.map((item) => {
          const Icon = item.state === 'on' ? CheckCircle2 : item.state === 'skipped' ? MinusCircle : Circle;
          const tone = item.state === 'on' ? 'text-green-300 border-green-400/30 bg-green-400/10' : 'text-white/60 border-white/15 bg-white/[0.04]';
          return (
            <li key={item.id} className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${tone}`}>
              <Icon className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{item.label}</span>
              <span className="sr-only">: </span>
              <span className="font-medium">{STATE_TEXT[item.state]}</span>
            </li>
          );
        })}
      </ul>
      <a href="/operations#systems/connections" className="inline-block mt-2 text-xs text-[#60a5fa] underline underline-offset-2">
        Open Systems &gt; Connections
      </a>
    </div>
  );
}
