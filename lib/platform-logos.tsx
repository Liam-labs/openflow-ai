import React from 'react';
import { Bot } from 'lucide-react';

// OpenAI knot SVG fallback — brand PNG pending from the owner
function OpenAILogo({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M12 2L14.5 8.5L21 11L14.5 13.5L12 20L9.5 13.5L3 11L9.5 8.5L12 2Z" fill="white" fillOpacity="0.8" />
    </svg>
  );
}

export function getPlatformColor(modelId: string): string {
  const m = modelId.toLowerCase();
  if (m.startsWith('deepseek') || m === 'v4') return 'ring-blue-400/40';
  if (m.includes('gemini')) return 'ring-blue-400/30';
  if (m.includes('grok')) return 'ring-slate-300/25';
  if (/gpt|openai/i.test(m)) return 'ring-emerald-400/40';
  return 'ring-orange-400/40'; // Claude
}

// Platform logo images — served from /public/icons/platforms/
export function getPlatformLogo(modelId: string | undefined | null): React.ReactNode {
  if (!modelId) return <Bot className="w-4 h-4 text-white/80" />;
  const m = modelId.toLowerCase();
  if (m.startsWith('deepseek') || m === 'v4') return <img src="/icons/platforms/deepseek.png" className="w-4 h-4 object-contain" alt="DeepSeek" />;
  if (m.includes('gemini')) return <img src="/icons/platforms/gemini.png" className="w-4 h-4 object-contain" alt="Gemini" />;
  if (m.includes('grok')) return <span className="flex items-center justify-center w-4 h-4 rounded-[3px] bg-white"><img src="/icons/platforms/grok.png" className="w-3.5 h-3.5 object-contain" alt="Grok" /></span>;
  if (/gpt|openai/i.test(m)) return <OpenAILogo className="w-4 h-4" />;
  // Anthropic Claude (opus, sonnet, haiku, claude-*)
  return <img src="/icons/platforms/claude.png" className="w-4 h-4 object-contain" alt="Claude" />;
}
