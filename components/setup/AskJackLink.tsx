'use client';

/**
 * "Ask Jack about this" in a setup card's dialog. It puts a question about the card in the Setup channel's message box (as a saved draft,
 * the way the chat keeps unsent text) and opens that channel, so the user reads it, edits it if they like and presses Enter.
 * It draws nothing until the Setup channel exists.
 */

import { useEffect, useState } from 'react';
import { MessageCircle } from 'lucide-react';

export function askJackDraft(topic: string): string {
  return `@Jack Tell me about "${topic}": what is it useful for, do I need it, and what does it need?`;
}

export function AskJackLink({ topic }: { topic: string }) {
  const [channelId, setChannelId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/setup/summary', { cache: 'no-store' });
        const json = await res.json();
        if (alive && res.ok && json.success && typeof json.setupChannelId === 'string') setChannelId(json.setupChannelId);
      } catch { /* no link is better than a broken one */ }
    })();
    return () => { alive = false; };
  }, []);

  if (!channelId) return null;
  const open = (e: React.MouseEvent) => {
    e.preventDefault();
    try { localStorage.setItem(`devflow-draft-${channelId}`, askJackDraft(topic)); } catch { /* the question is a convenience */ }
    window.location.assign(`/?channel=${encodeURIComponent(channelId)}`);
  };
  return (
    <a href={`/?channel=${encodeURIComponent(channelId)}`} onClick={open} className="inline-flex items-center gap-1.5 mt-1 text-xs text-[#60a5fa] underline underline-offset-2">
      <MessageCircle className="w-3.5 h-3.5" aria-hidden="true" /> Ask Jack about this
    </a>
  );
}
