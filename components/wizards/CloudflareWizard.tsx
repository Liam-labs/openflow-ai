'use client';

/**
 * WebGate wizard: put the dashboard on your own Cloudflare domain behind Cloudflare Access, with your own free account.
 * Talks to /api/wizards/cloudflare (this computer only). The API token is typed here once, checked by the server and never shown again.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, Loader2 } from 'lucide-react';
import { ProofList, StatusPill, WizardFrame, type ProofLine } from '@/components/wizards/WizardFrame';
import { looksLikeCloudflareToken } from '@/lib/wizards/cloudflare-token-shape';

interface Zone { id: string; name: string; accountId: string }
interface Perm { scope: string; name: string; level: string }
interface State {
  passwordSet: boolean; tokenSaved: boolean; url: string | null;
  record: { enabled: boolean; stage: string; hostname?: string; known?: { accountId: string; zones: Zone[] } };
  connector: { installed: boolean; version: string | null; running: boolean };
  permissions: Perm[];
  tokenLink: string; tokenName: string; defaultEmail: string;
}

async function call(body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    const res = await fetch('/api/wizards/cloudflare', body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
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

const STAGE_TEXT: Record<string, string> = { policy: 'sign-in rule made', app: 'Access application made', tunnel: 'tunnel made', config: 'tunnel route saved', dns: 'address created' };

export function CloudflareWizard() {
  const [state, setState] = useState<State | null>(null);
  const [loadError, setLoadError] = useState('');
  const [token, setToken] = useState('');
  const [tokenResult, setTokenResult] = useState<{ ok: boolean; problems: string[]; notes: string[]; details: string[] } | null>(null);
  const [chosenZoneId, setZoneId] = useState<string | null>(null);
  const [sub, setSub] = useState('openflow');
  const [chosenEmails, setEmails] = useState<string | null>(null);
  const [busy, setBusy] = useState<'token' | 'enable' | 'prove' | 'disable' | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string; fix?: string } | null>(null);
  const [proof, setProofRaw] = useState<ProofLine[] | null>(null);
  // Test results appear on the Test step: bump the signal so the dialog moves there by itself.
  const [testSignal, setTestSignal] = useState(0);
  const setProof = (p: ProofLine[] | null) => { setProofRaw(p); if (p) setTestSignal(t => t + 1); };
  const [confirmOff, setConfirmOff] = useState(false);
  const [opened, setOpened] = useState(false);
  // The last token we checked: coming back from Cloudflare before copying the new one must not check the old one again.
  const lastChecked = useRef('');

  const apply = (r: Record<string, unknown>) => { if (r.record) setState(r as unknown as State); };
  const refresh = useCallback(async () => {
    const r = await call();
    if (r.success) { apply(r); setLoadError(''); } else setLoadError(typeof r.error === 'string' ? r.error : 'Could not read the state. Check your connection and try again.');
  }, []);
  // The initial state update follows an asynchronous API read.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void refresh(); }, [refresh]);

  const zones = state?.record.known?.zones ?? [];
  const zoneId = chosenZoneId ?? zones[0]?.id ?? '';
  const emails = chosenEmails ?? state?.defaultEmail ?? '';

  const saveToken = useCallback(async (value: string) => {
    setBusy('token'); setTokenResult(null); lastChecked.current = value.trim();
    const r = await call({ action: 'save-token', token: value });
    setBusy(null); apply(r);
    setTokenResult({ ok: !!r.success, problems: Array.isArray(r.problems) && r.problems.length ? (r.problems as string[]) : r.success ? [] : [typeof r.error === 'string' ? r.error : 'The token could not be checked. Try again.'], notes: Array.isArray(r.notes) ? (r.notes as string[]) : [], details: Array.isArray(r.details) ? (r.details as string[]) : [] });
    if (r.success) setToken('');
  }, []);

  // After the person has opened Cloudflare, read a token from the clipboard when they come back, and check it. Needs no paste.
  useEffect(() => {
    if (!opened || state?.tokenSaved || busy !== null) return;
    let stop = false;
    const look = async () => {
      try {
        const text = await navigator.clipboard?.readText();
        if (!stop && looksLikeCloudflareToken(text) && text.trim() !== lastChecked.current) { setToken(text.trim()); setOpened(false); void saveToken(text.trim()); }
      } catch { /* the browser said no or has no clipboard access: the paste box is still there */ }
    };
    const onVisible = () => { if (document.visibilityState === 'visible') void look(); };
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => { stop = true; window.removeEventListener('focus', onVisible); document.removeEventListener('visibilitychange', onVisible); };
  }, [opened, state?.tokenSaved, busy, saveToken]);

  // Offer the address from this computer's git settings as the one allowed to sign in.


  const runProof = async () => {
    setBusy('prove');
    const p = await call({ action: 'prove' });
    setBusy(null); apply(p);
    setProof(Array.isArray(p.steps) ? (p.steps as ProofLine[]) : [{ name: 'The test could run', ok: false, detail: typeof p.error === 'string' ? p.error : 'It did not finish.' }]);
    if (p.takenDown) setMessage({ ok: false, text: 'The address showed the dashboard to a visitor who had not signed in, so everything was taken down again.' });
  };
  const enable = async () => {
    setBusy('enable'); setMessage(null); setProof(null);
    const r = await call({ action: 'enable', zoneId, subdomain: sub, emails });
    setBusy(null); apply(r);
    if (r.success) { setMessage({ ok: true, text: `Switched on at ${String(r.url)}.` }); await runProof(); } else setMessage({ ok: false, text: typeof r.error === 'string' ? r.error : 'It did not switch on.', fix: typeof r.fix === 'string' ? r.fix : undefined });
  };
  const disable = async () => {
    setBusy('disable'); setMessage(null); setProof(null);
    const r = await call({ action: 'disable' });
    setBusy(null); setConfirmOff(false); apply(r);
    setMessage(r.success ? { ok: true, text: typeof r.note === 'string' ? r.note : 'Switched off.' } : { ok: false, text: typeof r.error === 'string' ? r.error : 'It did not switch off.' });
  };
  const forget = async () => { setBusy('disable'); const r = await call({ action: 'forget-token' }); setBusy(null); apply(r); setTokenResult(null); setMessage(r.success ? { ok: true, text: 'Token deleted from this computer.' } : { ok: false, text: typeof r.error === 'string' ? r.error : 'Could not delete it.' }); };

  const input = 'glass-input text-sm py-2 w-full';
  const stage = state?.record.stage ?? 'none';
  const live = stage === 'live';
  const partial = !!state?.record.enabled && !live && stage !== 'none';
  const fix = message?.fix;
  const hold = !state ? 'Reading the state of this computer…' : live ? null
    : !state.tokenSaved ? 'Make the token and let the wizard check it first. Continue switches on when the check passes.'
    : 'Press Switch on first. Continue switches on once it is on and the test has run.';
  return (
    <WizardFrame
      holdSetup={hold}
      testSignal={testSignal}
      title="Reach it from anywhere with your Cloudflare domain"
      status={state ? <StatusPill tone={live ? 'good' : partial ? 'warn' : 'idle'}>{live ? 'On' : partial ? 'Partly set up' : 'Off'}</StatusPill> : <Loader2 className="w-3.5 h-3.5 animate-spin text-white/40" />}
      check={loadError ? <div role="alert"><p className="text-sm text-red-300">{loadError}</p><button type="button" className="glass-button mt-3 px-4 py-3" onClick={() => void refresh()}>Try again</button></div> : state ? (
        <ul className="text-xs text-white/70 flex flex-col gap-1">
          <li>{state.passwordSet ? 'A sign-in password is set.' : 'No sign-in password yet: set one in the wizard above first.'}</li>
          <li>{state.connector.installed ? `cloudflared ${state.connector.version ?? ''} is installed.` : 'cloudflared (Cloudflare\'s connector program) is not installed on this computer yet.'}</li>
          <li>{state.tokenSaved ? 'A Cloudflare token is saved on this computer.' : 'No Cloudflare token yet.'}</li>
          {live && state.url && <li>Your dashboard is published at {state.url}, behind Cloudflare sign-in.</li>}
          {partial && <li>Set up part way ({STAGE_TEXT[stage] ?? stage}). Press Switch on to finish, or switch off to remove it.</li>}
        </ul>
      ) : <p className="text-xs text-white/40">Reading…</p>}
      explain={<p className="text-xs text-white/60 leading-relaxed">Publishes this dashboard at an address on <em>your own</em> Cloudflare domain, for example openflow.yourdomain.com, so you can open it from anywhere. Cloudflare Access sits in front: only the email addresses you list can get in (Cloudflare emails them a one-time code), and the dashboard still asks for its own password after that. It makes one Access rule and application, one tunnel and one DNS record in <em>your</em> Cloudflare account, and runs Cloudflare&apos;s connector on this computer. It never replaces a DNS record that already exists, and the tunnel can only reach this app. Undo removes exactly what it made.</p>}
      doIt={
        <div className="flex flex-col gap-3">
          {!state?.tokenSaved && state && (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-white/60">Step 1: make a Cloudflare token that can do only this.</p>
              <div>
                <a className="glass-button primary px-4 py-2 text-xs inline-block" href={state.tokenLink} target="_blank" rel="noreferrer" onClick={() => setOpened(true)}>
                  Open Cloudflare with the permissions filled in
                </a>
              </div>
              <ol className="text-xs text-white/70 list-decimal pl-5 flex flex-col gap-1">
                <li>On the Cloudflare page, check that all four permissions are listed. If one is missing, add it by hand.</li>
                <li>Under Zone Resources, change <em>All zones</em> to your one domain.</li>
                <li>Press Continue to summary, then Create Token, then Copy.</li>
                <li>Come back to this page. It reads the token from your clipboard and checks it. If it does not, paste it below.</li>
              </ol>
              <details className="text-[11px] text-white/50">
                <summary className="cursor-pointer">What the token can do</summary>
                <ul className="list-disc pl-5 mt-1">
                  {(state.permissions ?? []).map((p) => <li key={`${p.scope}${p.name}`}>{p.scope}: {p.name}: {p.level}</li>)}
                </ul>
                <p className="mt-1">The token is named &quot;{state.tokenName}&quot;. Delete it in Cloudflare when you no longer need it.</p>
              </details>
              <input type="password" className={input} placeholder="Or paste the token here" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false} aria-label="Cloudflare API token" />
              <div><button type="button" className="glass-button px-4 py-2 text-xs" disabled={busy !== null || !token} onClick={() => void saveToken(token)}>{busy === 'token' ? 'Checking…' : 'Check token'}</button></div>
              {busy === 'token' && !token && <p className="text-xs text-white/60" role="status">Checking the token from your clipboard…</p>}
              {tokenResult && !tokenResult.ok && (
                <div className="flex flex-col gap-1" role="alert">
                  <ul className="text-xs text-red-300 flex flex-col gap-1">{tokenResult.problems.map((p) => <li key={p}>{p}</li>)}</ul>
                  <div><a className="glass-button px-3 py-1.5 text-xs inline-block" href={state.tokenLink} target="_blank" rel="noreferrer" onClick={() => setOpened(true)}>Open Cloudflare again</a></div>
                </div>
              )}
              {tokenResult && !tokenResult.ok && tokenResult.details.length > 0 && (
                <details className="text-[11px] text-white/50"><summary className="cursor-pointer">What the check saw</summary><ul className="list-disc pl-5 mt-1">{tokenResult.details.map((d) => <li key={d}>{d}</li>)}</ul></details>
              )}
              {tokenResult?.notes.length ? <ul className="text-[11px] text-white/40">{tokenResult.notes.map((n) => <li key={n}>{n}</li>)}</ul> : null}
            </div>
          )}
          {state?.tokenSaved && !live && (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-green-300">Token checked: it can do what the wizard needs and nothing more.</p>
              <select className={input} value={zoneId} onChange={(e) => setZoneId(e.target.value)} aria-label="Domain" disabled={partial}>
                {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
              </select>
              <input className={input} value={sub} onChange={(e) => setSub(e.target.value)} placeholder="Address name, e.g. openflow" aria-label="Address name" disabled={partial} />
              <input className={input} value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="Email addresses allowed to sign in (separate with commas)" aria-label="Allowed email addresses" disabled={partial && !emails} />
              {zones.find((z) => z.id === zoneId) && sub && <p className="text-[11px] text-white/40">Address: https://{sub.toLowerCase()}.{zones.find((z) => z.id === zoneId)!.name}</p>}
              <div className="flex items-center gap-2">
                <button type="button" className="glass-button primary px-4 py-2 text-xs" disabled={busy !== null || !state.passwordSet || !emails} onClick={() => void enable()}>{busy === 'enable' ? 'Setting up (about a minute)…' : partial ? 'Continue' : 'Switch on'}</button>
              </div>
            </div>
          )}
          {fix === 'cloudflared' && (
            <div className="flex flex-col gap-2 rounded-lg border border-yellow-400/20 bg-yellow-400/5 p-3">
              <p className="text-xs text-yellow-200">Install Cloudflare&apos;s connector program, then press Switch on again:</p>
              <CopyLine text="brew install cloudflared" />
              <a className="text-xs text-blue-300 underline" href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" target="_blank" rel="noreferrer">Downloads for Linux, Windows and Mac</a>
            </div>
          )}
          {fix === 'zerotrust' && (
            <div className="rounded-lg border border-yellow-400/20 bg-yellow-400/5 p-3 text-xs text-yellow-200">
              Open <a className="text-blue-300 underline" href="https://one.dash.cloudflare.com/" target="_blank" rel="noreferrer">Cloudflare Zero Trust</a> once and choose a team name (the free plan is enough), then press Switch on again.
            </div>
          )}
          {message && <p className={`text-xs ${message.ok ? 'text-green-300' : 'text-red-300'}`} role="status">{message.text}</p>}
        </div>
      }
      prove={
        <div className="flex flex-col gap-2">
          <ProofList lines={proof} busy={busy === 'prove'} />
          {!live && !proof && busy !== 'prove' && <p className="text-xs text-white/60">The test runs by itself right after Switch on. Nothing is switched on yet, so there is nothing to test. Go back to Set it up and finish it.</p>}
          {live && <div><button type="button" className="glass-button px-3 py-1.5 text-xs" disabled={busy !== null} onClick={() => void runProof()}>Check again</button></div>}
          {live && <p className="text-[11px] text-white/40">The check asks the real public address with no sign-in. It must land on Cloudflare&apos;s sign-in page. If it ever shows the dashboard, everything is taken down at once.</p>}
        </div>
      }
      undo={
        live || partial ? (
          confirmOff ? (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-white/60">Remove the address, tunnel and Access rule?</span>
              <button type="button" className="glass-button px-3 py-1.5 text-xs text-red-300" disabled={busy !== null} onClick={() => void disable()}>Yes, remove them</button>
              <button type="button" className="text-white/50 hover:text-white/80 px-2" onClick={() => setConfirmOff(false)}>Keep them</button>
            </div>
          ) : <div><button type="button" className="glass-button px-3 py-1.5 text-xs" disabled={busy !== null} onClick={() => setConfirmOff(true)}>Switch off</button></div>
        ) : state?.tokenSaved ? (
          <div className="flex flex-col gap-1">
            <p className="text-xs text-white/40">Nothing is switched on.</p>
            <div><button type="button" className="glass-button px-3 py-1.5 text-xs" disabled={busy !== null} onClick={() => void forget()}>Delete the saved token</button></div>
          </div>
        ) : <p className="text-xs text-white/40">Nothing to undo.</p>
      }
    />
  );
}
