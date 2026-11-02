'use client';

/**
 * Memory wizard: shared memory your agents can store to and search, kept on this computer (Qdrant in Docker + a small local model).
 * Talks to /api/wizards/memory (this computer only). Skipping is a normal answer.
 */
import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Loader2 } from 'lucide-react';
import { ProofList, StatusPill, WizardFrame, type ProofLine } from '@/components/wizards/WizardFrame';

interface Facts { managedDatabase?: boolean; docker: { installed: boolean; running: boolean }; python: { ok: boolean; version: string | null }; uv: boolean; availableMB: number; diskFreeMB: number; qdrantUp: boolean; container: { exists: boolean; running: boolean } }
type Plan = { ok: true; model: 'light' | 'better'; adopt: boolean } | { ok: false; reason: string; fix?: string };
interface State { facts: Facts; plan: Plan; record: { enabled: boolean; skipped: boolean; stage: string; adopted: boolean; model: string | null; mcp: boolean }; models: Record<string, { id: string; label: string; needMB: number; downloadMB: number }> }

async function call(body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
  const res = await fetch('/api/wizards/memory', body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  return (await res.json().catch(() => ({ success: false, error: 'The server sent something unreadable.' }))) as Record<string, unknown>;
  } catch {
    return { success: false, error: 'Could not reach the server. Check your connection, then try again.' };
  }
}

function CopyLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-lg bg-black/30 border border-white/10 px-3 py-2">
      <code className="text-xs text-white/80 break-all flex-1">{text}</code>
      <button type="button" className="text-white/50 hover:text-white/90 flex-shrink-0" aria-label="Copy" onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>
        {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
}

const FIXES: Record<string, { text: string; command?: string; link?: { href: string; label: string } }> = {
  docker: { text: 'Install Docker, then press Check again:', link: { href: 'https://docs.docker.com/get-started/get-docker/', label: 'Docker for Linux, Mac and Windows' } },
  'docker-start': { text: 'Docker is installed but not running. Start it, then press Check again:', command: 'sudo systemctl start docker' },
  python: { text: 'Install uv (recommended: it brings its own Python), or Python with its venv module, then press Check again:', command: 'curl -LsSf https://astral.sh/uv/install.sh | sh' },
};

const gb = (mb: number) => `${Math.round(mb / 100) / 10} GB`;

export function MemoryWizard() {
  const [state, setState] = useState<State | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState<'enable' | 'prove' | 'agent' | 'skip' | 'disable' | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [proof, setProofRaw] = useState<ProofLine[] | null>(null);
  // Test results appear on the Test step: bump the signal so the dialog moves there by itself.
  const [testSignal, setTestSignal] = useState(0);
  const setProof = (p: ProofLine[] | null) => { setProofRaw(p); if (p) setTestSignal(t => t + 1); };
  const [exposed, setExposed] = useState(false);
  const [model, setModel] = useState<'light' | 'better' | ''>('');
  const [confirm, setConfirm] = useState<'off' | 'delete' | null>(null);

  const apply = (r: Record<string, unknown>) => { if (r.facts) setState(r as unknown as State); };
  const acceptRead = useCallback((r: Record<string, unknown>) => {
    if (r.success && r.facts) { setState(r as unknown as State); setLoadError(''); }
    else setLoadError(typeof r.error === 'string' ? r.error : 'Could not read the memory state. Check your connection and try again.');
  }, []);
  const refresh = useCallback(async () => { acceptRead(await call()); }, [acceptRead]);
  useEffect(() => {
    let cancelled = false;
    void call().then(r => { if (!cancelled) acceptRead(r); });
    return () => { cancelled = true; };
  }, [acceptRead]);

  const prove = async () => {
    setBusy('prove');
    const p = await call({ action: 'prove' });
    setBusy(null); apply(p);
    setProof(Array.isArray(p.steps) ? (p.steps as ProofLine[]) : [{ name: 'The test completed', ok: false, detail: typeof p.error === 'string' ? p.error : 'The server did not return a test result. Try again.' }]);
    setExposed(p.exposed === true);
  };
  const enable = async () => {
    setBusy('enable'); setMessage(null); setProof(null); setExposed(false);
    const r = await call({ action: 'enable', model: model || undefined });
    setBusy(null); apply(r);
    if (r.success) { setMessage({ ok: true, text: 'Memory is set up on this computer.' }); await prove(); } else setMessage({ ok: false, text: typeof r.error === 'string' ? r.error : 'It did not finish.' });
  };
  const simple = async (action: string, busyKey: 'agent' | 'skip' | 'disable', body: Record<string, unknown> = {}) => {
    setBusy(busyKey); setMessage(null); setConfirm(null);
    const r = await call({ action, ...body });
    setBusy(null); apply(r);
    setMessage(r.success ? { ok: true, text: typeof r.note === 'string' ? r.note : typeof r.message === 'string' ? r.message : 'Done.' } : { ok: false, text: typeof r.error === 'string' ? r.error : 'It did not work.' });
    if (action === 'disable') { setProof(null); setExposed(false); }
  };

  const f = state?.facts;
  const rec = state?.record;
  const ready = !!rec?.enabled && rec.stage === 'ready';
  const partial = !!rec?.enabled && !ready;
  const plan = state?.plan;
  const fix = plan && !plan.ok && plan.fix && !f?.managedDatabase ? FIXES[plan.fix] : undefined;
  return (
    <WizardFrame
      message={message ?? (loadError ? { ok: false, text: loadError } : null)}
      testSignal={testSignal}
      title="Shared memory for your agents"
      status={state ? <StatusPill tone={ready ? 'good' : partial ? 'warn' : 'idle'}>{ready ? 'On' : partial ? 'Partly set up' : rec?.skipped ? 'Skipped' : 'Off'}</StatusPill> : <Loader2 className="w-3.5 h-3.5 animate-spin text-white/40" />}
      check={loadError ? <p className="text-xs text-yellow-300">{loadError}</p> : state && f ? (
        <ul className="text-xs text-white/70 flex flex-col gap-1">
          <li>{f.managedDatabase ? (f.qdrantUp ? 'The private memory database inside OpenFlow is running.' : 'OpenFlow manages its own private memory database. No Docker installation is needed.') : f.docker.running ? 'Docker is running.' : f.docker.installed ? 'Docker is installed but not running.' : f.qdrantUp ? 'Docker was not found, but a Qdrant database is already running here and will be used.' : 'Docker is not installed.'}</li>
          <li>{f.uv ? 'uv is installed (it makes the Python environment).' : f.python.ok ? `Python ${f.python.version} is ready.` : 'Neither uv nor Python 3.9 to 3.13 with venv was found.'}</li>
          <li>About {gb(f.availableMB)} of memory and {gb(f.diskFreeMB)} of disk are free.{plan?.ok ? ` The ${plan.model === 'better' ? 'better' : 'light'} model fits.` : ''}</li>
          {!f.managedDatabase && f.qdrantUp && !f.container.exists && <li>A Qdrant database is already answering on port 6333; the wizard will use it and leave it running when you undo.</li>}
          {rec?.skipped && <li>You skipped this. Nothing is installed and nothing will complain; you can set it up any time.</li>}
        </ul>
      ) : <p className="text-xs text-white/40">Reading…</p>}
      explain={<p className="text-xs text-white/60 leading-relaxed">Gives your agents a shared memory: they can store what they learn and search it later (tools <code>qdrant-store</code> and <code>qdrant-find</code>). {f?.managedDatabase ? 'The database runs inside OpenFlow with persistent storage and is accessible only within this installation. No host Docker access is needed. It uses a small local language model to turn text into searchable form' : 'It runs the Qdrant database in Docker, offered to this computer only, and a small language model that runs on this computer to turn text into searchable form'} (downloaded once, {state?.models.light.downloadMB ?? 90}–{state?.models.better.downloadMB ?? 440} MB). Nothing is sent to anyone. Skipping is fine: everything else works without it.</p>}
      doIt={
        <div className="flex flex-col gap-2">
          {fix && <div className="flex flex-col gap-2 rounded-lg border border-yellow-400/20 bg-yellow-400/5 p-3"><p className="text-xs text-yellow-200">{fix.text}</p>{fix.command && <CopyLine text={fix.command} />}{fix.link && <a className="text-xs text-blue-300 underline" href={fix.link.href} target="_blank" rel="noreferrer">{fix.link.label}</a>}</div>}
          {plan && !plan.ok && !fix && <p className="text-xs text-yellow-300">{plan.reason}</p>}
          {state && f && !ready && f.availableMB >= state.models.better.needMB && (
            <select className="glass-input text-sm py-2 w-full" value={model || (plan?.ok ? plan.model : 'light')} onChange={(e) => setModel(e.target.value as 'light' | 'better')} aria-label="Model">
              <option value="light">{state.models.light.label}</option>
              <option value="better">{state.models.better.label}</option>
            </select>
          )}
          <div className="flex items-center gap-2 flex-wrap">
            <button type="button" className="glass-button primary px-4 py-2 text-xs" disabled={busy !== null || ready || !state || !plan?.ok} onClick={() => void enable()}>{busy === 'enable' ? 'Setting up (a few minutes the first time)…' : partial ? 'Continue' : 'Set up memory'}</button>
            <button type="button" className="glass-button px-3 py-2 text-xs" disabled={busy !== null || !ready || !!rec?.mcp} onClick={() => void simple('add-agent-access', 'agent')}>{rec?.mcp ? 'Agents can use it' : 'Let my agents use it'}</button>
            {!ready && !partial && !rec?.skipped && <button type="button" className="glass-button px-3 py-2 text-xs" disabled={busy !== null} onClick={() => void simple('skip', 'skip')}>Skip for now</button>}
            <button type="button" className="glass-button px-3 py-2 text-xs" disabled={busy !== null} onClick={() => void refresh()}>Check again</button>
          </div>
        </div>
      }
      prove={
        <div className="flex flex-col gap-2">
          <ProofList lines={proof} busy={busy === 'prove'} />
          {exposed && <p className="text-xs text-red-300" role="alert">Another address on this computer could reach the database. Fix that (firewall or Docker port settings) before using memory.</p>}
          {ready && <div><button type="button" className="glass-button px-3 py-1.5 text-xs" disabled={busy !== null} onClick={() => void prove()}>Run the check again</button></div>}
        </div>
      }
      undo={
        rec?.enabled ? (
          confirm ? (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-white/60">{confirm === 'delete' ? 'Switch off and delete everything agents stored?' : 'Switch memory off? Stored memories are kept.'}</span>
              <button type="button" className="glass-button px-3 py-1.5 text-xs text-red-300" disabled={busy !== null} onClick={() => void simple('disable', 'disable', { deleteData: confirm === 'delete' })}>Yes</button>
              <button type="button" className="text-white/50 hover:text-white/80 px-2" onClick={() => setConfirm(null)}>No</button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <button type="button" className="glass-button px-3 py-1.5 text-xs" disabled={busy !== null} onClick={() => setConfirm('off')}>Switch off</button>
              <button type="button" className="glass-button px-3 py-1.5 text-xs" disabled={busy !== null} onClick={() => setConfirm('delete')}>Switch off and delete memories</button>
            </div>
          )
        ) : <p className="text-xs text-white/40">Nothing to undo.</p>
      }
    />
  );
}
