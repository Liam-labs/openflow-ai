'use client';

/**
 * Optional connectors: AI tools, MCP servers, image and video providers, GitHub, email and so on.
 * Reads /api/connectors (the catalog plus what this machine already has), and lets the user set each one up:
 * install and sign-in steps, a key box with a Check button, or an Add button for an MCP server.
 * Used in the setup wizard ("compact") and in Systems > Connections ("page").
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bot, BookOpen, Check, ClipboardPaste, ChevronDown, ChevronRight, Clapperboard, Copy, ExternalLink, FolderOpen, GitBranch, KeyRound, ListOrdered, Loader2, Mail, MousePointerClick, NotebookPen, Plug, RefreshCw, Eye, EyeOff, Server, Sparkles, SquareTerminal, Terminal, Workflow, Zap, Image as ImageIcon, type LucideIcon } from 'lucide-react';
import { Logo } from '@/components/setup-cards/Logo';
import { SetupCard } from '@/components/setup-cards/SetupCard';
import { SetupModal } from '@/components/setup-cards/SetupModal';
import bundledCatalog from '@/data/connectors-catalog.json';
import type { Connector, ConnectorsCatalog } from '@/lib/connectors/catalog';
import type { ConnectorState, ConnectorStatus } from '@/lib/connectors/detect';
import { installArgv } from '@/lib/connectors/install-parse';
import { COST_LABEL, STATE_LABEL, STATE_TONE, formatStepResults, type StepOutcome } from '@/lib/connectors/labels';

interface Props {
  variant?: 'page' | 'compact';
}

interface Loaded { catalog: ConnectorsCatalog; statuses: Record<string, ConnectorStatus> }

/** Where a connector has no brand mark, a glyph for what it does. */
const GLYPH_BY_ID: Record<string, LucideIcon> = {
  codex: SquareTerminal, xai: Sparkles, openai: Bot, 'mcp-filesystem': FolderOpen, 'mcp-playwright': MousePointerClick, 'mcp-context7': BookOpen,
  'mcp-memory': NotebookPen, 'mcp-sequential-thinking': ListOrdered, higgsfield: Clapperboard, fal: Zap,
};
const GLYPH_BY_KIND: Record<Connector['kind'], LucideIcon> = { cli: Terminal, 'api-key': KeyRound, mcp: Plug, 'local-service': Server };
const GLYPH_BY_CATEGORY: Record<string, LucideIcon> = { ai: Sparkles, mcp: Plug, media: ImageIcon, dev: GitBranch, comms: Mail, automation: Workflow };
const glyphFor = (c: Connector): LucideIcon => GLYPH_BY_ID[c.id] ?? GLYPH_BY_KIND[c.kind];

async function call(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch('/api/connectors', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return (await res.json().catch(() => ({ success: false, error: 'The server sent something unreadable.' }))) as Record<string, unknown>;
}

function StatePill({ state }: { state: ConnectorState }) {
  return <span className={`text-[11px] px-2 py-0.5 rounded-full border ${STATE_TONE[state]}`}>{STATE_LABEL[state]}</span>;
}

/** The same state on a Set up more card: a shape and a word, one accent. */
function CardPill({ state }: { state: ConnectorState }) {
  const tone = state === 'ready' || state === 'running' ? 'good' : state === 'installed' ? 'warn' : 'idle';
  return <span className={`sc-pill sc-pill--${tone}`}>{STATE_LABEL[state]}</span>;
}

function SecretBox({ label, placeholder, value, onChange }: { label: string; placeholder?: string; value: string; onChange: (v: string) => void }) {
  const [visible, setVisible] = useState(false);
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-white/50 font-medium">{label}</span>
      <span className="relative">
        <input
          type={visible ? 'text' : 'password'}
          className="glass-input pr-9 text-sm py-2 w-full"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <button type="button" tabIndex={-1} onClick={() => setVisible((v) => !v)} aria-label={visible ? 'Hide key' : 'Show key'} className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-white/30 hover:text-white/70">
          {visible ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
        </button>
      </span>
    </label>
  );
}

/** What a pasted key may look like: one run of ordinary characters, no spaces or line breaks. */
const KEY_SHAPE = /^[A-Za-z0-9_\-.:~+/=]{16,400}$/;

function CopyCommand({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-lg bg-black/30 border border-white/10 px-3 py-2">
      <code className="text-xs text-white/80 break-all flex-1">{text}</code>
      <button
        type="button"
        className="text-white/50 hover:text-white/90 flex-shrink-0"
        aria-label="Copy command"
        onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
      >
        {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
}

/** The skill hints option. Shown on the TypeSafe Jev card: available once Jev is connected, never switched on by connecting. */
function SkillHintsSwitch({ refreshKey }: { refreshKey: number }) {
  const [info, setInfo] = useState<{ available: boolean; reason: string | null; mode: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/skill-router/settings', { cache: 'no-store' });
      const d = await r.json();
      if (d?.success) setInfo({ available: d.available === true, reason: d.reason ?? null, mode: String(d.mode) });
    } catch { /* leave as it was */ }
  }, []);
  useEffect(() => { void load(); }, [load, refreshKey]);
  if (!info) return null;
  const on = info.mode === 'on';
  const toggle = async () => {
    setBusy(true); setError(null);
    try {
      const r = await fetch('/api/skill-router/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: on ? 'off' : 'on' }) });
      const d = await r.json();
      if (!d?.success) setError(String(d?.error ?? 'That did not work.'));
      await load();
    } catch { setError('Could not reach the server.'); } finally { setBusy(false); }
  };
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] p-3" data-testid="skill-hints-switch">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-white">Skill hints</span>
        <button type="button" role="switch" aria-checked={on} aria-label="Skill hints" disabled={busy || (!info.available && !on)} onClick={() => void toggle()}
          className={`glass-button px-3 py-1.5 text-xs disabled:opacity-40 ${on ? 'primary text-white' : 'text-white/70'}`}>
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : on ? 'On' : 'Off'}
        </button>
      </div>
      <p className="text-xs text-white/55">When on, each message sent to an agent is also checked by TypeSafe Jev, which adds one line suggesting a skill the agent can load or ignore. The text of the message is sent to TypeSafe. Messages that look like passwords or keys are never sent.</p>
      {!info.available && <p className="text-xs text-amber-300">{info.reason ?? 'Connect TypeSafe Jev above to use this.'}</p>}
      {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
    </div>
  );
}

function ConnectorCard({ c, status, onChanged, variant }: { c: Connector; status: ConnectorStatus; onChanged: () => Promise<void>; variant: 'page' | 'compact' }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [key, setKey] = useState('');
  const [envKeys, setEnvKeys] = useState<Record<string, string>>({});
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const mcp = c.setup.mcp;
  const isReady = status.state === 'ready' || status.state === 'running';

  const run = async (label: string, body: Record<string, unknown>, after?: (r: Record<string, unknown>) => { ok: boolean; text: string }) => {
    setBusy(label);
    setMessage(null);
    try {
      const r = await call({ id: c.id, ...body });
      const shaped = after ? after(r) : { ok: r.success === true, text: String(r.error ?? 'Done.') };
      setMessage(shaped);
      if (shaped.ok) { setKey(''); setEnvKeys({}); }
      await onChanged();
    } catch {
      setMessage({ ok: false, text: 'Could not reach the server.' });
    } finally {
      setBusy(null);
    }
  };

  const saveKey = (env?: string, value?: string) =>
    run('save', { action: 'save-key', env, value: value ?? key }, (r) => ({ ok: r.success === true, text: r.success === true ? 'Saved. Agents started from now on can use it.' : String(r.error) }));
  // With the box empty the server checks the key already saved (or set on this machine), so a saved key can be verified without retyping it.
  const checkKey = () =>
    run('check', { action: 'test-key', value: key }, (r) => ({ ok: r.success === true && r.ok === true, text: String(r.message ?? r.error ?? 'No answer.') }));

  /** One click: take the key from the clipboard, check it with the provider when there is a test, then save it. */
  const pasteAndSave = async (env?: string) => {
    let text = '';
    try { text = (await navigator.clipboard.readText()).trim(); } catch { setMessage({ ok: false, text: 'The browser did not let this page read the clipboard. Paste the key into the box instead.' }); return; }
    if (!KEY_SHAPE.test(text)) { setMessage({ ok: false, text: 'The clipboard does not hold a key. Copy the key from the provider page, then press this again.' }); return; }
    const test = c.setup.key?.test;
    setBusy('paste');
    setMessage(null);
    try {
      if (test && !env) {
        const t = await call({ id: c.id, action: 'test-key', value: text });
        if (!(t.success === true && t.ok === true)) { setMessage({ ok: false, text: String(t.message ?? t.error ?? 'The provider did not accept that key.') }); return; }
      }
      const r = await call({ id: c.id, action: 'save-key', env, value: text });
      setMessage({ ok: r.success === true, text: r.success === true ? (test && !env ? 'Key accepted and saved. Agents started from now on can use it.' : 'Saved. Agents started from now on can use it.') : String(r.error) });
      if (r.success === true) { setKey(''); setEnvKeys({}); }
      await onChanged();
    } catch {
      setMessage({ ok: false, text: 'Could not reach the server.' });
    } finally {
      setBusy(null);
    }
  };

  const canInstall = !!installArgv(c.setup.command);
  const installBlock = canInstall && (
    <button type="button" disabled={!!busy} onClick={() => run('install', { action: 'install' }, (r) => ({ ok: r.success === true, text: String(r.message ?? r.error ?? 'No answer.') }))} className="glass-button primary self-start px-3 py-1.5 text-xs text-white disabled:opacity-40">
      {busy === 'install' ? <span className="inline-flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" />Installing, this can take a minute…</span> : 'Run it for me'}
    </button>
  );

  const openBlock = c.setup.open && (
    <a href={c.setup.open.url} target="_blank" rel="noopener noreferrer" className="glass-button primary inline-flex items-center gap-1.5 self-start px-3 py-1.5 text-xs text-white">
      {c.setup.open.label} <ExternalLink className="w-3 h-3" aria-hidden="true" />
    </a>
  );

  const keyBlock = c.setup.key && (
    <div className="flex flex-col gap-2">
      <button type="button" disabled={!!busy} onClick={() => void pasteAndSave()} className="glass-button primary self-start px-3 py-1.5 text-xs text-white disabled:opacity-40">
        {busy === 'paste' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <span className="inline-flex items-center gap-1.5"><ClipboardPaste className="w-3.5 h-3.5" aria-hidden="true" />Paste and save</span>}
      </button>
      <SecretBox label={`${c.setup.key.label}, or type it here`} placeholder={c.setup.key.placeholder} value={key} onChange={setKey} />
      <div className="flex gap-2">
        {c.setup.key.test && (
          <button type="button" disabled={(!key.trim() && !status.keyFrom) || !!busy} onClick={checkKey} className="glass-button px-3 py-1.5 text-xs text-[#60a5fa] disabled:opacity-40">
            {busy === 'check' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Check'}
          </button>
        )}
        <button type="button" disabled={!key.trim() || !!busy} onClick={() => saveKey()} className="glass-button primary px-3 py-1.5 text-xs text-white disabled:opacity-40">
          {busy === 'save' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Save'}
        </button>
        {status.keyFrom === 'saved' && (
          <button type="button" disabled={!!busy} onClick={() => run('remove', { action: 'remove-key' }, (r) => ({ ok: r.success === true, text: r.success === true ? 'Key removed.' : String(r.error) }))} className="glass-button px-3 py-1.5 text-xs text-white/50">
            Remove key
          </button>
        )}
      </div>
      {status.keyFrom === 'environment' && <p className="text-xs text-white/45">A key is already set on this machine. Saving here replaces it for your agents.</p>}
    </div>
  );

  const mcpBlock = mcp && (
    <div className="flex flex-col gap-2">
      {(mcp.inputs ?? []).map((i) => (
        <label key={i.id} className="flex flex-col gap-1">
          <span className="text-xs text-white/50 font-medium">{i.label}</span>
          <input className="glass-input text-sm py-2" placeholder={i.placeholder} value={inputs[i.id] ?? ''} onChange={(e) => setInputs((p) => ({ ...p, [i.id]: e.target.value }))} spellCheck={false} />
        </label>
      ))}
      {(mcp.env ?? []).map((e) => (
        <div key={e.name} className="flex flex-col gap-2">
          <SecretBox label={e.label} placeholder={e.placeholder} value={envKeys[e.name] ?? ''} onChange={(v) => setEnvKeys((p) => ({ ...p, [e.name]: v }))} />
          <button type="button" disabled={!!busy} onClick={() => void pasteAndSave(e.name)} className="glass-button primary self-start px-3 py-1.5 text-xs text-white disabled:opacity-40">
            {busy === 'paste' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <span className="inline-flex items-center gap-1.5"><ClipboardPaste className="w-3.5 h-3.5" aria-hidden="true" />Paste and save</span>}
          </button>
          <button type="button" disabled={!(envKeys[e.name] ?? '').trim() || !!busy} onClick={() => saveKey(e.name, envKeys[e.name])} className="glass-button self-start px-3 py-1.5 text-xs text-[#60a5fa] disabled:opacity-40">
            Save {e.label.toLowerCase()}
          </button>
        </div>
      ))}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={!!busy}
          onClick={() => run('add', { action: 'add-mcp', inputs }, (r) => ({ ok: r.success === true, text: r.error ? String(r.error) : formatStepResults((r.results ?? []) as StepOutcome[]) }))}
          className="glass-button primary px-3 py-1.5 text-xs text-white disabled:opacity-40"
        >
          {busy === 'add' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : isReady ? 'Add again' : 'Add'}
        </button>
        {isReady && (
          <button type="button" disabled={!!busy} onClick={() => run('remove', { action: 'remove-mcp' }, (r) => ({ ok: r.success === true, text: r.error ? String(r.error) : formatStepResults((r.results ?? []) as StepOutcome[]) }))} className="glass-button px-3 py-1.5 text-xs text-white/50">
            Remove
          </button>
        )}
      </div>
    </div>
  );

  const messageBlock = message && <p role="status" className={`text-xs ${message.ok ? 'text-green-400' : 'text-red-400'}`}>{message.text}</p>;
  const docsLink = (
    <a href={c.docs} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[#60a5fa] hover:underline">
      Docs <ExternalLink className="w-3 h-3" />
    </a>
  );

  if (variant === 'page') {
    const cost = (<div className="sc-meta"><span className="sc-cost">{c.cost}</span></div>);
    // The three kinds of setup end the same way: do the last thing, then see the state change.
    const lastTitle = c.setup.key ? 'Add your key' : mcp ? 'Add it to your team' : 'Check it is ready';
    const steps = [...c.setup.steps];
    return (
      <>
        <SetupCard
          logo={<Logo brand={c.id} Glyph={glyphFor(c)} />}
          name={c.name}
          headline={c.headline ?? c.name}
          summary={c.summary}
          why={c.why}
          recommended={c.recommended ? 'Recommended' : undefined}
          status={<CardPill state={status.state} />}
          chips={<span className="sc-chip">{COST_LABEL[c.costKind]}</span>}
          ready={isReady}
          onOpen={() => setOpen(true)}
        />
        {open && (
          <SetupModal title={c.headline ?? c.name} subtitle={c.name === (c.headline ?? c.name) ? c.summary : `${c.name}. ${c.summary}`} logo={<Logo brand={c.id} Glyph={glyphFor(c)} size="lg" />} status={<CardPill state={status.state} />} onClose={() => setOpen(false)}>
            {cost}
            <div className="sc-panel sc-panel--bare">
              <ol className="sc-tl">
                {steps.map((t, i) => (
                  <li key={t}><span className="sc-n">{i + 1}</span><div className="sc-tl-body"><p>{t}</p>{i === 0 && openBlock}{i === 0 && installBlock}{i === 0 && c.setup.command && <CopyCommand text={c.setup.command} />}</div></li>
                ))}
                <li>
                  <span className="sc-n"><Check aria-hidden="true" /></span>
                  <div className="sc-tl-body">
                    <h4>{lastTitle}</h4>
                    {keyBlock}
                    {mcpBlock}
                    {!c.setup.key && !mcp && (
                      <div className="flex gap-2"><button type="button" className="glass-button px-3 py-1.5 text-xs" disabled={!!busy} onClick={() => void onChanged()}>Look again</button></div>
                    )}
                    {messageBlock}
                    {c.id === 'typesafe-jev' && <SkillHintsSwitch refreshKey={status.state === 'ready' ? 1 : 0} />}
                    {status.notes.length > 0 && <p className="sc-note">{status.notes.join(' · ')}</p>}
                    <div>{docsLink}</div>
                  </div>
                </li>
              </ol>
            </div>
          </SetupModal>
        )}
      </>
    );
  }

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03]">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="w-full flex items-start gap-3 text-left px-4 py-3">
        {open ? <ChevronDown className="w-4 h-4 mt-1 text-white/40 flex-shrink-0" /> : <ChevronRight className="w-4 h-4 mt-1 text-white/40 flex-shrink-0" />}
        <span className="flex-1 min-w-0">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-white">{c.name}</span>
            {c.recommended && <span className="text-[11px] px-2 py-0.5 rounded-full border border-blue-400/30 text-blue-300 bg-blue-400/10">Recommended</span>}
            <StatePill state={status.state} />
            <span className="text-[11px] text-white/40">{COST_LABEL[c.costKind]}</span>
          </span>
          <span className="block text-xs text-white/55 mt-1">{c.summary}</span>
        </span>
      </button>

      {open && (
        <div className="px-4 pb-4 pl-11 flex flex-col gap-3">
          <p className="text-xs text-white/60"><span className="text-white/40">Cost: </span>{c.cost}</p>
          <ol className="list-decimal pl-4 text-xs text-white/70 flex flex-col gap-1">
            {c.setup.steps.map((s) => <li key={s}>{s}</li>)}
          </ol>
          {openBlock}
          {installBlock}
          {c.setup.command && <CopyCommand text={c.setup.command} />}
          {keyBlock}
          {mcpBlock}
          {messageBlock}
          {c.id === 'typesafe-jev' && <SkillHintsSwitch refreshKey={status.state === 'ready' ? 1 : 0} />}
          <div className="flex items-center gap-4 text-xs text-white/40">
            <span>{status.notes.join(' · ')}</span>
            {docsLink}
          </div>
        </div>
      )}
    </div>
  );
}

export function ConnectorsPanel({ variant = 'page' }: Props) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch('/api/connectors', { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || 'failed');
      const statuses: Record<string, ConnectorStatus> = {};
      for (const s of json.statuses as ConnectorStatus[]) statuses[s.id] = s;
      setLoaded({ catalog: json.catalog, statuses });
      setError('');
    } catch {
      setLoaded(current => current ?? { catalog: bundledCatalog as ConnectorsCatalog, statuses: {} });
      setError('Connection status could not be loaded. These services are available to set up; retry to check their status.');
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const groups = useMemo(() => {
    if (!loaded) return [];
    return loaded.catalog.categories
      .map((cat) => ({ cat, items: loaded.catalog.connectors.filter((c) => c.category === cat.id) }))
      .filter((g) => g.items.length > 0);
  }, [loaded]);

  const errorNotice = error ? <p role="alert" className="text-sm text-red-400">{error} <button type="button" onClick={() => void load()}>Retry</button></p> : null;
  if (!loaded) return <p className="text-sm text-white/50 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Looking at what is already set up…</p>;

  const total = loaded.catalog.connectors.length;
  const ready = Object.values(loaded.statuses).filter((s) => s.state === 'ready' || s.state === 'running').length;

  const statusOf = (c: Connector): ConnectorStatus => loaded.statuses[c.id] ?? { id: c.id, state: error ? 'unknown' : 'not-set-up', notes: [] };

  if (variant === 'page') {
    return (
      <>
        {errorNotice}
        <div className="sc-bar">
          <p className="sc-lead">{ready} of {total} ready. Everything here is optional; set up what you will use.</p>
          <button type="button" className="sc-refresh" onClick={() => void load()} disabled={refreshing} aria-label="Look again" title="Look again">
            <RefreshCw className={refreshing ? 'animate-spin' : ''} />
          </button>
        </div>
        {groups.map(({ cat, items }) => {
          const Icon = GLYPH_BY_CATEGORY[cat.id] ?? Plug;
          const done = items.filter((c) => { const st = statusOf(c).state; return st === 'ready' || st === 'running'; }).length;
          return (
            <section key={cat.id} className="sc-group" aria-labelledby={`sc-g-${cat.id}`}>
              <div className="sc-gh">
                <span className="sc-gh-ic" aria-hidden="true"><Icon /></span>
                <h3 id={`sc-g-${cat.id}`}>{cat.label}</h3>
                <span className="sc-gh-count">{done} of {items.length} ready</span>
              </div>
              <div className="sc-grid">
                {items.map((c) => <ConnectorCard key={c.id} c={c} status={statusOf(c)} onChanged={load} variant="page" />)}
              </div>
            </section>
          );
        })}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-5" data-variant={variant}>
      {errorNotice}
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-white/50">
          {ready} of {total} ready. Everything here is optional; set up what you will use.
        </p>
        <button type="button" onClick={() => void load()} disabled={refreshing} className="text-white/40 hover:text-white/80" aria-label="Look again">
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>
      {groups.map(({ cat, items }) => (
        <section key={cat.id} className="flex flex-col gap-2">
          <h3 className="text-xs uppercase tracking-wide text-white/40 font-medium">{cat.label}</h3>
          {items.map((c) => (
            <ConnectorCard key={c.id} c={c} status={statusOf(c)} onChanged={load} variant="compact" />
          ))}
        </section>
      ))}
    </div>
  );
}
