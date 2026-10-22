'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, AppWindow, Check, Copy, ExternalLink, Link2, Loader2, RefreshCw, Terminal, Wrench } from 'lucide-react';
import type { ChannelTool, ChannelToolWarning, ChannelToolsStatus } from '@/lib/channel-tools';

/**
 * "Channel tools" launcher (bottom of the AgentChat sidebar). Lists the tools in the selected channel's
 * `channel-tools/` folder and opens them: link and html tools open in a new tab; script tools show the
 * command to copy and run (DevFlow never runs anything from the browser).
 */

interface ToolsResponse {
  success: boolean;
  status: ChannelToolsStatus;
  message?: string;
  dir?: string | null;
  tools: ChannelTool[];
  warnings: ChannelToolWarning[];
}

interface Props {
  channelId: string | null;
  channelName?: string;
  isExpanded: boolean;
  /** Icon-only button for the sidebar dock; the list opens upwards above it. */
  compact?: boolean;
}

const TYPE_LABEL: Record<ChannelTool['type'], string> = { link: 'Link', html: 'Web app', script: 'Script' };

function ToolIcon({ tool }: { tool: ChannelTool }) {
  if (tool.icon) return <span className="w-5 text-center text-sm leading-none flex-shrink-0" aria-hidden>{tool.icon}</span>;
  const Icon = tool.type === 'link' ? Link2 : tool.type === 'html' ? AppWindow : Terminal;
  return <Icon className="w-4 h-4 text-teal-300/80 flex-shrink-0" />;
}

function ScriptRow({ tool }: { tool: ChannelTool }) {
  const [copied, setCopied] = useState(false);
  const command = tool.cwd ? `cd ${tool.cwd} && ${tool.run}` : tool.run ?? '';
  const copy = () => {
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1500); };
    try {
      if (navigator.clipboard?.writeText) { navigator.clipboard.writeText(command).then(done, () => {}); return; }
    } catch { /* fall through */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = command; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); done();
    } catch { /* nothing more to try */ }
  };
  return (
    <div className="px-2 py-2 rounded-lg hover:bg-white/[0.04]" title={tool.whenToUse ? `Use when: ${tool.whenToUse}` : undefined}>
      <div className="flex items-center gap-2">
        <ToolIcon tool={tool} />
        <span className="flex-1 min-w-0 truncate text-[12px] text-white/85">{tool.name}</span>
      </div>
      {tool.description && <p className="mt-0.5 ml-7 text-[11px] text-white/45">{tool.description}</p>}
      <p className="mt-0.5 ml-7 text-[9px] uppercase tracking-wide text-white/30">{TYPE_LABEL.script}</p>
      <div className="mt-1.5 ml-7 flex items-start gap-1.5">
        <code className="flex-1 min-w-0 break-all rounded bg-black/40 border border-white/[0.08] px-1.5 py-1 text-[10.5px] text-teal-200/90">{command}</code>
        <button
          onClick={copy}
          className="p-1.5 rounded hover:bg-white/10 text-white/50 hover:text-white/90 transition-colors"
          title="Copy command, then run it in a terminal"
          aria-label={`Copy command for ${tool.name}`}
        >
          {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
      </div>
    </div>
  );
}

function OpenRow({ tool }: { tool: ChannelTool }) {
  const href = tool.type === 'html' ? tool.launchPath : tool.url;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex items-start gap-2 px-2 py-2 rounded-lg hover:bg-white/[0.06] transition-colors"
      title={tool.whenToUse ? `Use when: ${tool.whenToUse}` : tool.type === 'link' ? tool.url : `Open ${tool.name}`}
    >
      <span className="mt-0.5"><ToolIcon tool={tool} /></span>
      <span className="flex-1 min-w-0">
        <span className="block truncate text-[12px] text-white/85 group-hover:text-white">{tool.name}</span>
        {tool.description && <span className="block text-[11px] text-white/45">{tool.description}</span>}
        <span className="block mt-0.5 text-[9px] uppercase tracking-wide text-white/30">{TYPE_LABEL[tool.type]}</span>
      </span>
      <ExternalLink className="mt-1 w-3 h-3 flex-shrink-0 text-white/30 group-hover:text-white/70" />
    </a>
  );
}

export function ChannelToolsLauncher({ channelId, channelName, isExpanded, compact = false }: Props) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<ToolsResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    if (!channelId) { setData(null); return; }
    const mine = ++requestRef.current;
    setLoading(true);
    setFailed(false);
    try {
      const res = await fetch(`/api/channel-tools?channelId=${encodeURIComponent(channelId)}`, { cache: 'no-store' });
      const json = (await res.json()) as ToolsResponse;
      if (mine !== requestRef.current) return;
      if (!res.ok || !json.success) throw new Error('bad response');
      setData(json);
    } catch {
      if (mine === requestRef.current) setFailed(true);
    } finally {
      if (mine === requestRef.current) setLoading(false);
    }
  }, [channelId]);

  // Follow the selected channel; never show another channel's tools while the new list loads.
  useEffect(() => {
    setData(null);
    setFailed(false);
    void load();
  }, [load]);

  // Refresh each time the panel is opened so tools agents just added appear.
  useEffect(() => { if (open) void load(); }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const count = data?.tools.length ?? 0;
  const label = channelName ? `Channel tools for ${channelName}` : 'Channel tools';

  const body = () => {
    if (!channelId) return <p className="px-2 py-3 text-[11px] text-white/45">Select a channel to see its tools.</p>;
    if (loading && !data) {
      return <div className="flex items-center justify-center py-5"><Loader2 className="w-4 h-4 animate-spin text-white/40" /></div>;
    }
    if (failed || !data) {
      return (
        <div className="px-2 py-3 text-[11px] text-white/55 space-y-2">
          <p>Could not load this channel&apos;s tools.</p>
          <button onClick={() => void load()} className="inline-flex items-center gap-1 text-teal-300 hover:text-teal-200"><RefreshCw className="w-3 h-3" /> Try again</button>
        </div>
      );
    }
    if (data.status === 'host-offline' || data.status === 'host-outdated' || data.status === 'error') {
      return (
        <div className="px-2 py-3 text-[11px] text-white/55 space-y-2">
          <p className="flex gap-1.5"><AlertTriangle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0 mt-px" /><span>{data.message}</span></p>
          <button onClick={() => void load()} className="inline-flex items-center gap-1 text-teal-300 hover:text-teal-200"><RefreshCw className="w-3 h-3" /> Try again</button>
        </div>
      );
    }
    if (data.status === 'no-project') return <p className="px-2 py-3 text-[11px] text-white/45">{data.message}</p>;
    const empty = data.tools.length === 0;
    return (
      <>
        {empty && (
          <div className="px-2 py-3 text-[11px] text-white/45 space-y-1.5">
            <p>No tools in this channel yet.</p>
            <p>Agents add tools here by saving a folder with a <code className="text-white/65">tool.json</code> in this channel&apos;s <code className="text-white/65">channel-tools</code> folder. They show up here.</p>
          </div>
        )}
        {data.tools.map(t => (t.type === 'script' ? <ScriptRow key={t.id} tool={t} /> : <OpenRow key={t.id} tool={t} />))}
        {data.warnings.length > 0 && (
          <div className="mt-1 border-t border-white/[0.06] pt-1.5 px-2 space-y-1">
            {data.warnings.map(w => (
              <p key={w.id} className="flex gap-1.5 text-[10.5px] text-amber-300/80">
                <AlertTriangle className="w-3 h-3 flex-shrink-0 mt-px" />
                <span><span className="font-medium">{w.id}</span> was skipped: {w.message}.</span>
              </p>
            ))}
          </div>
        )}
      </>
    );
  };

  return (
    <div ref={wrapRef} className="relative">
      {open && (
        <div
          role="dialog"
          aria-label={label}
          className={`absolute z-[70] bg-[#14141a] border border-white/[0.12] rounded-lg shadow-2xl shadow-black/60 backdrop-blur-xl ${
            compact ? 'bottom-full left-0 mb-2 w-72 max-w-[calc(100vw-1.5rem)]'
              : isExpanded ? 'bottom-full left-0 right-0 mb-2' : 'bottom-0 left-full ml-2 w-72 max-w-[calc(100vw-4rem)]'
          }`}
        >
          <div className="flex items-center justify-between px-3 py-2 border-b border-white/[0.08]">
            <span className="min-w-0 truncate text-[11px] font-medium uppercase tracking-wide text-white/55">
              Channel tools{channelName ? ` · ${channelName}` : ''}
            </span>
            <button onClick={() => void load()} className="p-1 rounded hover:bg-white/10 text-white/40 hover:text-white/80" title="Refresh" aria-label="Refresh channel tools">
              <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
          <div className="max-h-[min(24rem,60vh)] overflow-y-auto p-1.5">{body()}</div>
        </div>
      )}
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-label={label}
        data-testid="channel-tools-button"
        className={compact
          ? 'cs-dock-btn !text-teal-300/80 hover:!text-teal-200'
          : isExpanded
          ? 'w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs bg-teal-500/8 hover:bg-teal-500/15 text-teal-300/80 hover:text-teal-200 border border-teal-500/10 hover:border-teal-500/25 transition-all'
          : 'relative p-1.5 rounded-lg hover:bg-teal-500/15 text-teal-300/70 hover:text-teal-200 transition-colors'}
        title={label}
      >
        <Wrench className={compact ? 'w-4 h-4' : 'w-3.5 h-3.5'} />
        {compact ? (
          count > 0 ? <span className="cs-dock-n">{count}</span> : null
        ) : isExpanded ? (
          <>
            <span>Channel tools</span>
            {count > 0 && <span className="ml-auto text-[10px] text-teal-300/60">{count}</span>}
          </>
        ) : count > 0 ? (
          <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] rounded-full bg-teal-500/80 text-[9px] leading-[14px] text-black text-center">{count}</span>
        ) : null}
      </button>
    </div>
  );
}
