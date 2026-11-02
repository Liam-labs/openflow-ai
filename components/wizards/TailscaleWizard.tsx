'use client';

/**
 * Remote access wizard, Tailscale route: reach this dashboard from your own phone or laptop over your private Tailscale network.
 * Talks to /api/wizards/tailscale (this computer only). Needs the sign-in password from the wizard above.
 */
import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Loader2 } from 'lucide-react';
import { ProofList, StatusPill, WizardFrame, type ProofLine } from '@/components/wizards/WizardFrame';

interface Facts { inContainer: boolean; installed: boolean; version: string | null; state: string | null; dnsName: string | null; httpsReady: boolean; operatorOk: boolean }
type Plan = { ok: true; https: boolean; port: number; url: string } | { ok: false; reason: string; fix?: string };
interface Active { url: string; port: number; https: boolean }
interface Visit { secondsAgo: number; device: string; user: string | null; allowed: boolean }
interface SecondDevice { state: 'waiting' | 'ok' | 'open'; detail: string }
interface State { facts: Facts; passwordSet: boolean; plan: Plan; active: Active | null; visits: Visit[]; secondDevice: SecondDevice | null }

async function call(body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    const res = await fetch('/api/wizards/tailscale', body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
    const result = await res.json().catch(() => ({ success: false, error: 'The server sent something unreadable. Try again.' }));
    if (!res.ok) return { ...result, success: false, error: result.error || 'The connection request failed. Try again.' };
    return result as Record<string, unknown>;
  } catch { return { success: false, error: 'Could not reach OpenFlow. Check your connection and try again.' }; }
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
  install: { text: 'Install Tailscale on this computer and sign in with your own account (free for personal use).', command: 'curl -fsSL https://tailscale.com/install.sh | sh', link: { href: 'https://tailscale.com/download', label: 'Windows, Mac and phone downloads' } },
  login: { text: 'Tailscale is installed but not signed in. Sign in with your own account:', command: 'sudo tailscale up' },
  container: { text: 'This app runs in a container, so Tailscale is set up on the computer that hosts it (not inside the container). On that computer, after installing Tailscale and signing in, run this (use your own port instead of 3000 if you changed OPENFLOW_PORT):', command: 'sudo tailscale serve --bg --http=8080 http://127.0.0.1:3000' },
  operator: { text: 'Allow this user to manage Tailscale Serve (one time, asks for your computer password):', command: 'sudo tailscale set --operator=$USER' },
};

export function TailscaleWizard() {
  const [state, setState] = useState<State | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState<'enable' | 'prove' | 'disable' | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string; fix?: string } | null>(null);
  const [proof, setProofRaw] = useState<ProofLine[] | null>(null);
  // Test results appear on the Test step: bump the signal so the dialog moves there by itself.
  const [testSignal, setTestSignal] = useState(0);
  const setProof = (p: ProofLine[] | null) => { setProofRaw(p); if (p) setTestSignal(t => t + 1); };
  const [confirmOff, setConfirmOff] = useState(false);

  const apply = (r: Record<string, unknown>) => { if (r.facts) setState(r as unknown as State); };
  const refresh = useCallback(async () => {
    const r = await call();
    if (r.success) { apply(r); setLoadError(''); } else setLoadError(typeof r.error === 'string' ? r.error : 'Could not read Tailscale. Check your connection and try again.');
  }, []);
  // The initial state update follows an asynchronous API read.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void refresh(); }, [refresh]);

  const enable = async () => {
    setBusy('enable'); setMessage(null); setProof(null);
    const r = await call({ action: 'enable' });
    setBusy(null); apply(r);
    setMessage(r.success ? { ok: true, text: `Switched on. Open ${String(r.url)} on a device that is signed in to your Tailscale.` } : { ok: false, text: typeof r.error === 'string' ? r.error : 'It did not switch on.', fix: typeof r.fix === 'string' ? r.fix : undefined });
    if (r.success) {
      setBusy('prove');
      const p = await call({ action: 'prove' });
      setBusy(null); apply(p);
      setProof(Array.isArray(p.steps) ? (p.steps as ProofLine[]) : [{ name: 'Connection test', ok: false, detail: typeof p.error === 'string' ? p.error : 'The test did not finish. Try again.' }]);
    }
  };
  const prove = async () => {
    setBusy('prove'); setMessage(null);
    const p = await call({ action: 'prove' });
    setBusy(null); apply(p);
    setProof(Array.isArray(p.steps) ? (p.steps as ProofLine[]) : [{ name: 'The test could run', ok: false, detail: typeof p.error === 'string' ? p.error : 'It did not finish.' }]);
  };
  const disable = async () => {
    setBusy('disable'); setMessage(null); setProof(null);
    const r = await call({ action: 'disable' });
    setBusy(null); setConfirmOff(false); apply(r);
    setMessage(r.success ? { ok: true, text: typeof r.note === 'string' ? r.note : 'Switched off.' } : { ok: false, text: typeof r.error === 'string' ? r.error : 'It did not switch off.' });
  };

  const f = state?.facts;
  const fix = message?.fix ?? (state && !state.plan.ok ? state.plan.fix : undefined);
  const fixInfo = !state?.passwordSet ? undefined : fix ? FIXES[fix] : undefined;
  return (
    <WizardFrame
      testSignal={testSignal}
      title="Reach it from your phone or laptop (Tailscale)"
      status={state ? <StatusPill tone={state.active ? 'good' : 'idle'}>{state.active ? 'On' : 'Off'}</StatusPill> : <Loader2 className="w-3.5 h-3.5 animate-spin text-white/40" />}
      check={loadError ? <div role="alert"><p className="text-sm text-red-300">{loadError}</p><button type="button" className="glass-button mt-3 px-4 py-3" onClick={() => void refresh()}>Try again</button></div> : state && f ? (
        <ul className="text-xs text-white/70 flex flex-col gap-1">
          <li>{f.inContainer ? 'This app is running in a container; Tailscale lives on the computer that hosts it.' : f.installed ? `Tailscale ${f.version ?? ''} is installed.` : 'Tailscale is not installed on this computer.'}</li>
          {f.installed && <li>{f.state === 'Running' && f.dnsName ? `Signed in. This computer is ${f.dnsName} on your private network.` : 'Not signed in yet.'}</li>}
          {f.installed && f.state === 'Running' && <li>{f.httpsReady ? 'Your Tailscale network has https certificates on, so the address will use https.' : 'https certificates are off on your Tailscale network, so the address will use plain http. That is still encrypted by Tailscale between your devices; turn on "HTTPS Certificates" in the Tailscale admin page to get https.'}</li>}
          <li>{state.passwordSet ? 'A sign-in password is set.' : 'No sign-in password yet: set one in the wizard above first.'}</li>
        </ul>
      ) : <p className="text-xs text-white/40">Reading…</p>}
      explain={<p className="text-xs text-white/60 leading-relaxed">Runs <code>tailscale serve</code> to share this dashboard with devices on <em>your own</em> Tailscale network only. It is not put on the public internet, and anyone who gets to the address still has to sign in with your password. It adds one Serve entry and changes nothing else in your Tailscale account. Undo removes just that entry.</p>}
      doIt={
        <div className="flex flex-col gap-2">
          {fixInfo && (
            <div className="flex flex-col gap-2 rounded-lg border border-yellow-400/20 bg-yellow-400/5 p-3">
              <p className="text-xs text-yellow-200">{fixInfo.text}</p>
              {fixInfo.command && <CopyLine text={fixInfo.command} />}
              {fixInfo.link && <a className="text-xs text-blue-300 underline" href={fixInfo.link.href} target="_blank" rel="noreferrer">{fixInfo.link.label}</a>}
              <p className="text-[11px] text-white/40">Then press Check again.</p>
            </div>
          )}
          {state && !state.plan.ok && !fixInfo && state.passwordSet && <p className="text-xs text-yellow-300">{state.plan.reason}</p>}
          <div className="flex items-center gap-2">
            <button type="button" className="glass-button primary px-4 py-2 text-xs" disabled={busy !== null || !state || !!state.active || !state.passwordSet || !state.plan.ok} onClick={() => void enable()}>
              {busy === 'enable' ? 'Switching on…' : 'Switch on remote access'}
            </button>
            <button type="button" className="glass-button px-3 py-2 text-xs" disabled={busy !== null} onClick={() => void refresh()}>Check again</button>
          </div>
          {message && <p className={`text-xs ${message.ok ? 'text-green-300' : 'text-red-300'}`} role="status">{message.text}</p>}
        </div>
      }
      prove={
        <div className="flex flex-col gap-3">
          <ProofList lines={proof} busy={busy === 'prove'} />
          {(state?.active || state?.facts.inContainer) && (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-white/60">From the computer that runs the app the address always opens without a password, so it cannot show the sign-in works. The real test is a second device: open the address on your phone or another computer that is signed in to your Tailscale. After opening it, press Check again to refresh the result.</p>
              {state.active && <CopyLine text={state.active.url} />}
              {!state.active && <p className="text-xs text-white/50">Open the address <code>tailscale serve status</code> shows on your other device.</p>}
              {state.secondDevice?.state === 'ok' && <p className="text-xs text-green-300" role="status">{state.secondDevice.detail}</p>}
              {state.secondDevice?.state === 'open' && <p className="text-xs text-red-300" role="alert">{state.secondDevice.detail}</p>}
              {state.secondDevice?.state === 'waiting' && <p className="text-xs text-white/40">{state.secondDevice.detail}</p>}
              {state.visits.length > 0 && (
                <ul className="text-[11px] text-white/45 flex flex-col gap-0.5">
                  {state.visits.map((v) => <li key={`${v.device}-${v.secondsAgo}`}>{v.device}{v.user ? ` (${v.user})` : ''}, {v.secondsAgo < 60 ? `${v.secondsAgo} seconds ago` : `${Math.round(v.secondsAgo / 60)} minutes ago`}: {v.allowed ? 'let in without signing in' : 'sent to the sign-in page'}</li>)}
                </ul>
              )}
              <div><button type="button" className="glass-button px-3 py-1.5 text-xs" disabled={busy !== null} onClick={() => void prove()}>Run the check again</button></div>
            </div>
          )}
        </div>
      }
      undo={
        state?.active ? (
          confirmOff ? (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-white/60">Switch off remote access?</span>
              <button type="button" className="glass-button px-3 py-1.5 text-xs text-red-300" disabled={busy !== null} onClick={() => void disable()}>Yes, switch it off</button>
              <button type="button" className="text-white/50 hover:text-white/80 px-2" onClick={() => setConfirmOff(false)}>Keep it</button>
            </div>
          ) : <div><button type="button" className="glass-button px-3 py-1.5 text-xs" disabled={busy !== null} onClick={() => setConfirmOff(true)}>Switch off remote access</button></div>
        ) : <p className="text-xs text-white/40">Nothing to undo.</p>
      }
    />
  );
}
