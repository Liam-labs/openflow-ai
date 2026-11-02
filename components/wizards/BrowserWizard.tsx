'use client';

/**
 * Browser-use wizard: a browser your agents can drive, with sign-ins you make once. Talks to /api/wizards/browser (this computer only).
 */
import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Loader2 } from 'lucide-react';
import { ProofList, StatusPill, WizardFrame, type ProofLine } from '@/components/wizards/WizardFrame';

interface State {
  record: { enabled: boolean; port: number | null; headless: boolean; mcp: boolean; profileDir: string | null };
  running: boolean;
  browser: { kind: string } | null;
  windowPossible: boolean;
}

async function call(body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch('/api/wizards/browser', body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  return (await res.json().catch(() => ({ success: false, error: 'The server sent something unreadable.' }))) as Record<string, unknown>;
}

const KIND: Record<string, string> = { chrome: 'Google Chrome', chromium: 'Chromium', edge: 'Microsoft Edge', playwright: 'the Chromium that comes with Playwright' };

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

export function BrowserWizard() {
  const [state, setState] = useState<State | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState<'start' | 'prove' | 'open' | 'agent' | 'stop' | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string; fix?: string } | null>(null);
  const [proof, setProofRaw] = useState<ProofLine[] | null>(null);
  // Test results appear on the Test step: bump the signal so the dialog moves there by itself.
  const [testSignal, setTestSignal] = useState(0);
  const setProof = (p: ProofLine[] | null) => { setProofRaw(p); if (p) setTestSignal(t => t + 1); };
  const [exposed, setExposed] = useState(false);
  const [url, setUrl] = useState('https://');
  const [confirm, setConfirm] = useState<'stop' | 'delete' | null>(null);

  const apply = (r: Record<string, unknown>) => { if (r.record) setState(r as unknown as State); };
  const refresh = useCallback(async () => {
    const r = await call();
    if (r.success) { apply(r); setLoadError(''); } else setLoadError(typeof r.error === 'string' ? r.error : 'Could not read the browser state. Open this page on the computer that runs the app.');
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const prove = async () => {
    setBusy('prove');
    const p = await call({ action: 'prove' });
    setBusy(null); apply(p);
    setProof(Array.isArray(p.steps) ? (p.steps as ProofLine[]) : null);
    setExposed(p.exposed === true);
  };
  const start = async () => {
    setBusy('start'); setMessage(null); setProof(null); setExposed(false);
    const r = await call({ action: 'start' });
    setBusy(null); apply(r);
    if (r.success) { setMessage({ ok: true, text: r.headless ? 'The browser is running without a window (this computer has no screen).' : 'The browser is running. A window opened on this computer.' }); await prove(); } else setMessage({ ok: false, text: typeof r.error === 'string' ? r.error : 'It did not start.', fix: typeof r.fix === 'string' ? r.fix : undefined });
  };
  const open = async () => {
    setBusy('open'); setMessage(null);
    const r = await call({ action: 'open', url });
    setBusy(null); apply(r);
    setMessage(r.success ? { ok: true, text: 'Opened in the browser window. Sign in there.' } : { ok: false, text: typeof r.error === 'string' ? r.error : 'It did not open.' });
  };
  const agent = async () => {
    setBusy('agent'); setMessage(null);
    const r = await call({ action: 'add-agent-access' });
    setBusy(null); apply(r);
    setMessage(r.success ? { ok: true, text: typeof r.message === 'string' ? r.message : 'Added.' } : { ok: false, text: typeof r.error === 'string' ? r.error : 'It was not added.' });
  };
  const stop = async (deleteProfile: boolean) => {
    setBusy('stop'); setMessage(null); setProof(null); setExposed(false);
    const r = await call({ action: 'stop', deleteProfile });
    setBusy(null); setConfirm(null); apply(r);
    setMessage(r.success ? { ok: true, text: typeof r.note === 'string' ? r.note : 'Stopped.' } : { ok: false, text: typeof r.error === 'string' ? r.error : 'It did not stop.' });
  };

  const on = !!state?.record.enabled && state.running;
  return (
    <WizardFrame
      message={message}
      testSignal={testSignal}
      title="A browser your agents can use"
      status={state ? <StatusPill tone={on ? 'good' : 'idle'}>{on ? 'Running' : 'Off'}</StatusPill> : <Loader2 className="w-3.5 h-3.5 animate-spin text-white/40" />}
      check={loadError ? <p className="text-xs text-yellow-300">{loadError}</p> : state ? (
        <ul className="text-xs text-white/70 flex flex-col gap-1">
          <li>{state.browser ? `Found ${KIND[state.browser.kind] ?? state.browser.kind}.` : 'No Chrome, Chromium or Edge was found on this computer.'}</li>
          <li>{state.windowPossible ? 'This computer can show a browser window, so you can sign in to websites in it.' : 'This computer has no screen, so the browser will run without a window. Agents can use public sites, but you cannot sign in to sites in it.'}</li>
          {on && <li>Running with its control port {state.record.port} open to this computer only.{state.record.mcp ? ' Agents are set up to use it.' : ''}</li>}
        </ul>
      ) : <p className="text-xs text-white/40">Reading…</p>}
      explain={<p className="text-xs text-white/60 leading-relaxed">Starts a separate browser with its own profile folder (your everyday browser is not touched) so agents can open pages, click and take screenshots, and so sites you sign in to stay signed in for them. Its control port gives full control of every site it is signed in to, so it only listens on this computer and the wizard checks that nothing else can reach it; if anything can, the browser is stopped. Undo stops it; your saved sign-ins stay unless you choose to delete them.</p>}
      doIt={
        <div className="flex flex-col gap-2">
          {message?.fix === 'install' && (
            <div className="flex flex-col gap-2 rounded-lg border border-yellow-400/20 bg-yellow-400/5 p-3">
              <p className="text-xs text-yellow-200">Install a browser, then press Start again:</p>
              <p className="text-[11px] text-white/50">Linux:</p>
              <CopyLine text="sudo apt install chromium" />
              <p className="text-[11px] text-white/50">Mac:</p>
              <CopyLine text="brew install --cask google-chrome" />
              <a className="text-xs text-blue-300 underline" href="https://www.google.com/chrome/" target="_blank" rel="noreferrer">Download Google Chrome</a>
            </div>
          )}
          {message?.fix === 'sandbox' && (
            <div className="flex flex-col gap-2 rounded-lg border border-yellow-400/20 bg-yellow-400/5 p-3">
              <p className="text-xs text-yellow-200">Linux is blocking the browser&apos;s sandbox here. Either install Google Chrome (it ships with permission), or allow it yourself:</p>
              <CopyLine text="sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0" />
              <a className="text-xs text-blue-300 underline" href="https://www.google.com/chrome/" target="_blank" rel="noreferrer">Download Google Chrome</a>
            </div>
          )}
          <div className="flex items-center gap-2">
            <button type="button" className="glass-button primary px-4 py-2 text-xs" disabled={busy !== null || on} onClick={() => void start()}>{busy === 'start' ? 'Starting…' : 'Start the browser'}</button>
            <button type="button" className="glass-button px-3 py-2 text-xs" disabled={busy !== null || !on || !!state?.record.mcp} onClick={() => void agent()}>{busy === 'agent' ? 'Adding…' : state?.record.mcp ? 'Agents can use it' : 'Let my agents use it'}</button>
          </div>
          {on && state?.windowPossible && (
            <div className="flex items-center gap-2">
              <input className="glass-input text-sm py-2 flex-1" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" aria-label="Site to open" />
              <button type="button" className="glass-button px-3 py-2 text-xs" disabled={busy !== null} onClick={() => void open()}>Open it to sign in</button>
            </div>
          )}
        </div>
      }
      prove={
        <div className="flex flex-col gap-2">
          <ProofList lines={proof} busy={busy === 'prove'} />
          {exposed && <p className="text-xs text-red-300" role="alert">Something other than this computer could reach the browser&apos;s control port, so the browser was stopped. Check your firewall and any port sharing, then start it again.</p>}
          {on && <div><button type="button" className="glass-button px-3 py-1.5 text-xs" disabled={busy !== null} onClick={() => void prove()}>Run the check again</button></div>}
        </div>
      }
      undo={
        state?.record.enabled || state?.record.profileDir ? (
          confirm ? (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-white/60">{confirm === 'delete' ? 'Stop the browser and delete everything you signed in to?' : 'Stop the browser and remove agent access?'}</span>
              <button type="button" className="glass-button px-3 py-1.5 text-xs text-red-300" disabled={busy !== null} onClick={() => void stop(confirm === 'delete')}>Yes</button>
              <button type="button" className="text-white/50 hover:text-white/80 px-2" onClick={() => setConfirm(null)}>No</button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              {state.record.enabled && <button type="button" className="glass-button px-3 py-1.5 text-xs" disabled={busy !== null} onClick={() => setConfirm('stop')}>Stop the browser</button>}
              {state.record.profileDir && <button type="button" className="glass-button px-3 py-1.5 text-xs" disabled={busy !== null} onClick={() => setConfirm('delete')}>Stop and delete saved sign-ins</button>}
            </div>
          )
        ) : <p className="text-xs text-white/40">Nothing to undo.</p>
      }
    />
  );
}
