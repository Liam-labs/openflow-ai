'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { Brain, RefreshCw, Download, Trash2, Send, Activity, AlertTriangle, Power, PowerOff, Loader2, Settings } from 'lucide-react';
import { LocalAIModelSettings } from './LocalAIModelSettings';

interface OllamaModel {
  name: string;
  size: number;
  modified_at: string;
  digest: string;
  details?: {
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
}

interface RunningModel {
  name: string;
  size_vram?: number;
  expires_at?: string;
}

interface LoadingState {
  model: string;
  startedAt: number;
  action: 'load' | 'unload';
}

function formatBytes(n: number): string {
  if (!n) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return `${(n / 1e3).toFixed(0)} KB`;
}

function formatDate(s: string): string {
  try {
    const d = new Date(s);
    const ms = Date.now() - d.getTime();
    const days = Math.floor(ms / 86_400_000);
    if (days === 0) return 'today';
    if (days === 1) return '1 day ago';
    if (days < 30) return `${days} days ago`;
    const months = Math.floor(days / 30);
    if (months === 1) return '1 month ago';
    return `${months} months ago`;
  } catch {
    return s;
  }
}

export function LocalAISection() {
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [running, setRunning] = useState<RunningModel[]>([]);
  const [version, setVersion] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  // Chat state — multi-turn message log persisted to localStorage
  type ChatMessage = { role: 'user' | 'assistant'; content: string };
  const CHAT_STORAGE_KEY = 'devflow.localai.chat.v1';
  const SELECTED_KEY = 'devflow.localai.selected.v1';
  const [prompt, setPrompt] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingResponse, setStreamingResponse] = useState<string>('');
  const [chatBusy, setChatBusy] = useState(false);
  const [chatStats, setChatStats] = useState<{ ms?: number | null; tokens?: number | null } | null>(null);

  // Hydrate chat + selected model from localStorage on mount (client-only)
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(CHAT_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { messages?: ChatMessage[] };
        if (Array.isArray(parsed.messages)) setMessages(parsed.messages);
      }
      const sel = window.localStorage.getItem(SELECTED_KEY);
      if (sel) setSelected(sel);
    } catch { /* ignore */ }
  }, []);

  // Persist chat on every change
  useEffect(() => {
    try {
      window.localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify({ messages }));
    } catch { /* ignore quota errors */ }
  }, [messages]);

  // Persist selected model
  useEffect(() => {
    if (!selected) return;
    try { window.localStorage.setItem(SELECTED_KEY, selected); } catch { /* ignore */ }
  }, [selected]);

  // Pull state
  const [pullName, setPullName] = useState('');
  const [pullStatus, setPullStatus] = useState<string>('');
  const [pullBusy, setPullBusy] = useState(false);

  // Load/unload state
  const [loadingState, setLoadingState] = useState<LoadingState | null>(null);
  const [loadElapsed, setLoadElapsed] = useState(0);

  // Settings modal
  const [settingsModel, setSettingsModel] = useState<OllamaModel | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll transcript to bottom when content changes
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streamingResponse]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [modelsR, versionR, runningR] = await Promise.all([
        fetch('/api/ollama?action=list', { cache: 'no-store' }),
        fetch('/api/ollama?action=version', { cache: 'no-store' }),
        fetch('/api/ollama?action=running', { cache: 'no-store' }),
      ]);
      const modelsJ = await modelsR.json();
      const versionJ = await versionR.json();
      const runningJ = await runningR.json();
      if (modelsJ.ok) {
        setModels(modelsJ.models);
      } else {
        setError(modelsJ.error ?? 'Ollama not reachable');
      }
      if (versionJ.ok) setVersion(versionJ.version);
      const runningList: RunningModel[] = (runningJ.ok ? runningJ.models ?? [] : []) as RunningModel[];
      if (runningJ.ok) setRunning(runningList);

      // First-load default: prefer a currently-loaded model so the panel reflects
      // reality (owner's ask). Only fall back to first-in-list if nothing is loaded
      // and nothing was persisted from a previous session.
      if (!selected) {
        if (runningList.length > 0) setSelected(runningList[0].name);
        else if (modelsJ.ok && modelsJ.models.length > 0) setSelected(modelsJ.models[0].name);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }, [selected]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 15_000);
    return () => clearInterval(id);
  }, [refresh]);

  // While a load/unload is in progress, tick elapsed seconds for the progress bar
  // and poll /api/ps faster so the UI flips state the moment it completes.
  useEffect(() => {
    if (!loadingState) return;
    const tick = setInterval(() => {
      setLoadElapsed(Math.round((Date.now() - loadingState.startedAt) / 100) / 10);
    }, 100);
    const poll = setInterval(async () => {
      try {
        const r = await fetch('/api/ollama?action=running', { cache: 'no-store' });
        const j = await r.json();
        if (j.ok) setRunning(j.models ?? []);
      } catch { /* ignore */ }
    }, 800);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [loadingState]);

  const handleLoad = async (name: string, num_ctx?: number) => {
    if (loadingState) return;
    setLoadingState({ model: name, startedAt: Date.now(), action: 'load' });
    setLoadElapsed(0);
    try {
      const r = await fetch('/api/ollama', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'load', model: name, ...(num_ctx ? { num_ctx } : {}) }),
      });
      const j = await r.json();
      if (!j.ok) {
        alert(`Load failed: ${j.error}`);
      }
    } catch (err) {
      alert(`Load error: ${err instanceof Error ? err.message : 'unknown'}`);
    } finally {
      setLoadingState(null);
      refresh();
    }
  };

  const handleUnload = async (name: string) => {
    if (loadingState) return;
    setLoadingState({ model: name, startedAt: Date.now(), action: 'unload' });
    setLoadElapsed(0);
    try {
      const r = await fetch('/api/ollama', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'unload', model: name }),
      });
      const j = await r.json();
      if (!j.ok) {
        alert(`Unload failed: ${j.error}`);
      }
    } catch (err) {
      alert(`Unload error: ${err instanceof Error ? err.message : 'unknown'}`);
    } finally {
      setLoadingState(null);
      refresh();
    }
  };

  const handleSend = async () => {
    if (!selected || !prompt.trim() || chatBusy) return;
    const userMessage: ChatMessage = { role: 'user', content: prompt.trim() };
    const conversation = [...messages, userMessage];
    setMessages(conversation);
    setPrompt('');
    setChatBusy(true);
    setStreamingResponse('');
    setChatStats(null);
    abortRef.current = new AbortController();
    const startedAt = Date.now();
    let acc = '';
    let tokenCount = 0;
    let gotStats = false;
    try {
      const r = await fetch('/api/ollama', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'chat-stream', model: selected, messages: conversation }),
        signal: abortRef.current.signal,
      });
      if (!r.ok || !r.body) {
        const txt = await r.text().catch(() => '');
        acc = `Error: ${txt || r.statusText}`;
        setStreamingResponse(acc);
      } else {
        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const obj = JSON.parse(line);
              const piece = obj.message?.content ?? '';
              if (piece) {
                acc += piece;
                tokenCount += 1;
                setStreamingResponse(acc);
              }
              if (obj.done) {
                if (obj.total_duration) {
                  setChatStats({ ms: Math.round(obj.total_duration / 1_000_000), tokens: obj.eval_count ?? tokenCount });
                  gotStats = true;
                }
              }
            } catch { /* ignore partial line */ }
          }
        }
      }
      // Commit assistant message at end
      const final = acc.trim();
      if (final) {
        setMessages([...conversation, { role: 'assistant', content: final }]);
      }
      setStreamingResponse('');
      if (!gotStats) {
        setChatStats({ ms: Date.now() - startedAt, tokens: tokenCount });
      }
    } catch (err) {
      if (err instanceof Error && err.name !== 'AbortError') {
        const msg = `Error: ${err.message}`;
        setMessages([...conversation, { role: 'assistant', content: msg }]);
        setStreamingResponse('');
      }
    } finally {
      setChatBusy(false);
    }
  };

  const handleClearChat = () => {
    setMessages([]);
    setStreamingResponse('');
    setChatStats(null);
  };

  const handlePull = async () => {
    if (!pullName.trim() || pullBusy) return;
    setPullBusy(true);
    setPullStatus('Starting…');
    try {
      const r = await fetch('/api/ollama', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'pull', model: pullName.trim() }),
      });
      if (!r.ok || !r.body) {
        setPullStatus(`Pull failed (${r.status})`);
        setPullBusy(false);
        return;
      }
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      // Stream NDJSON progress lines
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.error) {
              setPullStatus(`Error: ${obj.error}`);
            } else if (obj.total && obj.completed) {
              const pct = ((obj.completed / obj.total) * 100).toFixed(1);
              setPullStatus(`${obj.status ?? 'downloading'} — ${pct}%`);
            } else if (obj.status) {
              setPullStatus(obj.status);
            }
          } catch {
            // ignore parse errors
          }
        }
      }
      setPullStatus('Complete');
      setPullName('');
      await refresh();
    } catch (err) {
      setPullStatus(`Error: ${err instanceof Error ? err.message : 'Unknown'}`);
    } finally {
      setPullBusy(false);
    }
  };

  const handleDelete = async (name: string) => {
    if (!confirm(`Delete model "${name}"? This frees disk space but you'll need to re-pull to use it again.`)) return;
    const r = await fetch('/api/ollama', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', model: name }),
    });
    if (r.ok) {
      if (selected === name) setSelected(null);
      await refresh();
    } else {
      alert('Delete failed');
    }
  };

  const runningSet = new Set(running.map(m => m.name));
  const totalSize = models.reduce((sum, m) => sum + (m.size ?? 0), 0);

  return (
    <div className="systems-section">
      <div className="systems-section__header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 16px', borderBottom: '1px solid var(--border-subtle, #2a2a2a)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Brain size={16} />
          <strong>Local AI</strong>
          {version && <span style={{ fontSize: 11, opacity: 0.6 }}>Ollama {version}</span>}
          <span style={{ fontSize: 11, opacity: 0.6 }}>· {models.length} models · {formatBytes(totalSize)}</span>
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', background: 'transparent', border: '1px solid var(--border-subtle, #2a2a2a)', borderRadius: 4, cursor: 'pointer', color: 'inherit', fontSize: 12 }}
        >
          <RefreshCw size={12} className={loading ? 'spin' : ''} />
          Refresh
        </button>
      </div>

      {error && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 12, margin: 16, background: 'rgba(255, 100, 100, 0.1)', border: '1px solid rgba(255, 100, 100, 0.3)', borderRadius: 6, color: '#ff8888' }}>
          <AlertTriangle size={14} />
          <span style={{ fontSize: 13 }}>{error}. Is Ollama running? Try: <code>ollama serve</code></span>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(380px, 1fr) minmax(420px, 1.2fr)', gap: 16, padding: 16, alignItems: 'start' }}>
        {/* Left: model list */}
        <div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {models.length === 0 && !loading && !error && (
              <div style={{ padding: 24, textAlign: 'center', opacity: 0.6, fontSize: 13 }}>
                No models installed. Pull one below.
              </div>
            )}
            {models.map(m => {
              const isSelected = selected === m.name;
              const isRunning = runningSet.has(m.name);
              const isBusy = loadingState?.model === m.name;
              const otherBusy = loadingState !== null && !isBusy;
              return (
                <div
                  key={m.digest}
                  onClick={() => setSelected(m.name)}
                  style={{
                    padding: 10,
                    border: `1px solid ${isSelected ? 'var(--accent, #4a9eff)' : 'var(--border-subtle, #2a2a2a)'}`,
                    borderRadius: 6,
                    cursor: 'pointer',
                    background: isSelected ? 'rgba(74, 158, 255, 0.08)' : 'transparent',
                    opacity: otherBusy ? 0.5 : 1,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                        <strong style={{ fontSize: 13 }}>{m.name}</strong>
                        {isRunning && !isBusy && (
                          <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, padding: '2px 6px', background: 'rgba(80, 220, 100, 0.15)', color: '#5dd075', borderRadius: 3 }}>
                            <Activity size={10} />
                            loaded
                          </span>
                        )}
                        {isBusy && (
                          <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, padding: '2px 6px', background: 'rgba(74, 158, 255, 0.15)', color: '#4a9eff', borderRadius: 3 }}>
                            <Loader2 size={10} className="spin" />
                            {loadingState?.action === 'load' ? 'loading' : 'unloading'} · {loadElapsed.toFixed(1)}s
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 11, opacity: 0.6, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                        <span>{m.details?.parameter_size ?? '—'}</span>
                        <span>{m.details?.quantization_level ?? '—'}</span>
                        <span>{formatBytes(m.size)}</span>
                        <span>{formatDate(m.modified_at)}</span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <button
                        onClick={(e) => { e.stopPropagation(); setSettingsModel(m); }}
                        title="Model settings"
                        style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'inherit', opacity: 0.6, padding: 4 }}
                      >
                        <Settings size={14} />
                      </button>
                      {isRunning ? (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleUnload(m.name); }}
                          disabled={loadingState !== null}
                          title="Unload model from memory"
                          style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '4px 8px', background: 'rgba(255, 150, 80, 0.12)', border: '1px solid rgba(255, 150, 80, 0.3)', borderRadius: 4, cursor: loadingState ? 'wait' : 'pointer', color: '#ffa860', fontSize: 11 }}
                        >
                          <PowerOff size={11} /> Unload
                        </button>
                      ) : (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleLoad(m.name); }}
                          disabled={loadingState !== null}
                          title="Load model into memory"
                          style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '4px 8px', background: 'rgba(80, 220, 100, 0.12)', border: '1px solid rgba(80, 220, 100, 0.3)', borderRadius: 4, cursor: loadingState ? 'wait' : 'pointer', color: '#5dd075', fontSize: 11 }}
                        >
                          <Power size={11} /> Load
                        </button>
                      )}
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDelete(m.name); }}
                        disabled={loadingState !== null}
                        title="Delete model"
                        style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'inherit', opacity: 0.5, padding: 4 }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                  {isBusy && (
                    <div style={{ marginTop: 8, height: 4, background: 'rgba(74, 158, 255, 0.15)', borderRadius: 2, overflow: 'hidden' }}>
                      <div className="indeterminate-bar" style={{ height: '100%', background: 'var(--accent, #4a9eff)' }} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Pull form */}
          <div style={{ marginTop: 16, padding: 12, border: '1px solid var(--border-subtle, #2a2a2a)', borderRadius: 6 }}>
            <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Download size={12} /> Pull Model
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                type="text"
                value={pullName}
                onChange={e => setPullName(e.target.value)}
                placeholder="e.g. gemma4:e4b"
                disabled={pullBusy}
                style={{ flex: 1, padding: '6px 10px', background: 'var(--bg-input, #1a1a1a)', border: '1px solid var(--border-subtle, #2a2a2a)', borderRadius: 4, color: 'inherit', fontSize: 13 }}
              />
              <button
                onClick={handlePull}
                disabled={pullBusy || !pullName.trim()}
                style={{ padding: '6px 14px', background: 'var(--accent, #4a9eff)', border: 'none', borderRadius: 4, cursor: pullBusy ? 'wait' : 'pointer', color: 'white', fontSize: 13 }}
              >
                {pullBusy ? 'Pulling…' : 'Pull'}
              </button>
            </div>
            {pullStatus && (
              <div style={{ marginTop: 6, fontSize: 11, opacity: 0.7, fontFamily: 'monospace' }}>
                {pullStatus}
              </div>
            )}
            <div style={{ marginTop: 6, fontSize: 11, opacity: 0.5 }}>
              Browse models at <a href="https://ollama.com/library" target="_blank" rel="noreferrer" style={{ color: 'var(--accent, #4a9eff)' }}>ollama.com/library</a>
            </div>
          </div>
        </div>

        {/* Right: chat panel */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
          <div style={{ fontSize: 12, opacity: 0.7, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span>
              Chat {selected ? <code>{selected}</code> : '(select a model)'}
              {running.length > 0 && running[0].name === selected && (
                <span style={{ marginLeft: 6, fontSize: 10, color: '#4ade80', fontWeight: 600 }}>● LOADED</span>
              )}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {chatStats && (chatStats.ms || chatStats.tokens) && (
                <span style={{ fontSize: 11, opacity: 0.6 }}>
                  {chatStats.tokens ? `${chatStats.tokens} tokens` : ''}{chatStats.tokens && chatStats.ms ? ' · ' : ''}{chatStats.ms ? `${chatStats.ms} ms` : ''}
                </span>
              )}
              {messages.length > 0 && (
                <button
                  onClick={handleClearChat}
                  disabled={chatBusy}
                  title="Clear chat"
                  style={{ background: 'transparent', border: '1px solid var(--border-subtle, #2a2a2a)', borderRadius: 4, padding: '3px 8px', fontSize: 11, color: 'inherit', opacity: 0.7, cursor: 'pointer' }}
                >New chat</button>
              )}
            </span>
          </div>

          {/* Conversation transcript */}
          <div
            ref={transcriptRef}
            style={{
              flex: 1,
              minHeight: 220,
              maxHeight: 480,
              overflowY: 'auto',
              padding: 12,
              background: 'var(--bg-input, #0e0e0e)',
              border: '1px solid var(--border-subtle, #2a2a2a)',
              borderRadius: 6,
              fontSize: 13,
              lineHeight: 1.5,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            {messages.length === 0 && !chatBusy && (
              <span style={{ opacity: 0.4 }}>Conversation appears here. Persisted across page reloads.</span>
            )}
            {messages.map((m, i) => (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', opacity: 0.5, fontWeight: 600 }}>
                  {m.role === 'user' ? 'You' : 'Assistant'}
                </span>
                <div style={{
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  background: m.role === 'user' ? 'rgba(74,158,255,0.08)' : 'transparent',
                  padding: m.role === 'user' ? '8px 10px' : '0',
                  borderRadius: 6,
                  borderLeft: m.role === 'user' ? '2px solid var(--accent, #4a9eff)' : 'none',
                }}>
                  {m.content}
                </div>
              </div>
            ))}
            {chatBusy && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', opacity: 0.5, fontWeight: 600 }}>Assistant</span>
                <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {streamingResponse}
                  <span className="lai-caret" />
                </div>
              </div>
            )}
          </div>

          <textarea
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="Ask the model something… (Ctrl+Enter to send)"
            rows={3}
            disabled={!selected}
            style={{ width: '100%', padding: 10, background: 'var(--bg-input, #1a1a1a)', border: '1px solid var(--border-subtle, #2a2a2a)', borderRadius: 6, color: 'inherit', fontSize: 13, fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box' }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
            <button
              onClick={handleSend}
              disabled={!selected || !prompt.trim() || chatBusy}
              style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 14px', background: 'var(--accent, #4a9eff)', border: 'none', borderRadius: 4, cursor: chatBusy ? 'wait' : 'pointer', color: 'white', fontSize: 13 }}
            >
              <Send size={12} />
              {chatBusy ? 'Streaming…' : 'Send'}
            </button>
          </div>
        </div>
      </div>

      {settingsModel && (
        <LocalAIModelSettings
          modelName={settingsModel.name}
          modelSize={settingsModel.size}
          isLoaded={runningSet.has(settingsModel.name)}
          onClose={() => setSettingsModel(null)}
          onLoadWithCtx={(ctx) => handleLoad(settingsModel.name, ctx)}
          onUnload={() => handleUnload(settingsModel.name)}
          loadingState={loadingState ? { model: loadingState.model, action: loadingState.action } : null}
        />
      )}

      <style jsx>{`
        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .indeterminate-bar {
          width: 40%;
          animation: indeterminate 1.4s ease-in-out infinite;
        }
        @keyframes indeterminate {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(350%); }
        }
        .lai-caret {
          display: inline-block;
          width: 7px;
          height: 14px;
          margin-left: 2px;
          background: var(--accent, #4a9eff);
          vertical-align: text-bottom;
          animation: lai-caret-blink 1s steps(2, end) infinite;
        }
        @keyframes lai-caret-blink { 50% { opacity: 0; } }
      `}</style>
    </div>
  );
}
