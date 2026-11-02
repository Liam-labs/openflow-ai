'use client';

/**
 * Sign-in wizard: choose the password other computers use to open this dashboard, test it for real, or remove it.
 * Talks to /api/wizards/sign-in (this computer only). The password is held in this component just long enough to send it.
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { ProofList, StatusPill, WizardFrame, type ProofLine } from '@/components/wizards/WizardFrame';
import { generatePassword } from '@/lib/wizards/password-gen';

interface Check { passwordSet: boolean; setAt: string | null; signedInBrowsers: number; exposures: string[] }

async function call(body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch('/api/wizards/sign-in', body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  return (await res.json().catch(() => ({ success: false, error: 'The server sent something unreadable.' }))) as Record<string, unknown>;
}

export function SignInWizard() {
  const [check, setCheck] = useState<Check | null>(null);
  const [loadError, setLoadError] = useState('');
  const [pw, setPw] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState<'set' | 'prove' | 'undo' | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [proof, setProofRaw] = useState<ProofLine[] | null>(null);
  // Test results appear on the Test step: bump the signal so the dialog moves there by itself.
  const [testSignal, setTestSignal] = useState(0);
  const setProof = (p: ProofLine[] | null) => { setProofRaw(p); if (p) setTestSignal(t => t + 1); };
  const [confirmUndo, setConfirmUndo] = useState(false);
  const [made, setMade] = useState<string | null>(null);
  const [copiedMade, setCopiedMade] = useState(false);

  const refresh = useCallback(async () => {
    const r = await call();
    if (r.success) { setCheck(r as unknown as Check); setLoadError(''); } else setLoadError(typeof r.error === 'string' ? r.error : 'Could not read the sign-in state. Open this page on the computer that runs the app.');
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const runProof = async (password: string) => {
    setBusy('prove');
    const r = await call({ action: 'prove', password });
    setBusy(null);
    if (r.success && Array.isArray(r.steps)) setProof(r.steps as ProofLine[]);
    else setProof([{ name: 'The test could run', ok: false, detail: typeof r.error === 'string' ? r.error : 'The test did not finish.' }]);
  };

  const setAndTest = async () => {
    setMessage(null); setProof(null);
    if (pw !== again) { setMessage({ ok: false, text: 'The two passwords are different.' }); return; }
    setBusy('set');
    const r = await call({ action: 'set', password: pw });
    if (!r.success) { setBusy(null); setMessage({ ok: false, text: typeof r.error === 'string' ? r.error : 'The password was not saved.' }); return; }
    setMessage({ ok: true, text: 'Password saved. Every browser that was signed in has been signed out.' });
    const typed = pw;
    setPw(''); setAgain('');
    await refresh();
    await runProof(typed);
  };

  // One click: make a strong password, save it, test it, and show it once so it can be copied into a password manager.
  const makeOne = async () => {
    setMessage(null); setProof(null); setCopiedMade(false);
    const password = generatePassword();
    setBusy('set');
    const r = await call({ action: 'set', password });
    if (!r.success) { setBusy(null); setMessage({ ok: false, text: typeof r.error === 'string' ? r.error : 'The password was not saved.' }); return; }
    setMade(password);
    setMessage({ ok: true, text: 'Password saved. Every browser that was signed in has been signed out.' });
    await refresh();
    await runProof(password);
  };

  const retest = async () => {
    if (!pw) { setMessage({ ok: false, text: 'Type the password to test it.' }); return; }
    setMessage(null);
    const typed = pw;
    setPw('');
    await runProof(typed);
  };

  const undo = async () => {
    setBusy('undo'); setMessage(null); setProof(null);
    const r = await call({ action: 'undo' });
    setBusy(null); setConfirmUndo(false);
    setMessage(r.success ? { ok: true, text: 'Password removed. Other computers can no longer sign in.' } : { ok: false, text: typeof r.error === 'string' ? r.error : 'Could not remove it.' });
    await refresh();
  };

  const madeBox = made && (
            <div className="flex flex-col gap-1 rounded-lg border border-green-400/20 bg-green-400/5 p-3" role="status">
              <p className="text-xs text-green-200">Copy this password now. It is not shown again.</p>
              <div className="flex items-center gap-2 rounded-lg bg-black/30 border border-white/10 px-3 py-2">
                <code className="text-sm text-white/90 flex-1 tracking-wide" data-testid="made-password">{made}</code>
                <button type="button" className="glass-button px-3 py-1 text-xs" onClick={() => { void navigator.clipboard?.writeText(made).then(() => setCopiedMade(true)); }}>{copiedMade ? 'Copied' : 'Copy'}</button>
              </div>
              <div><button type="button" className="text-[11px] text-white/50 hover:text-white/80 underline" onClick={() => setMade(null)}>I have saved it</button></div>
            </div>
          );

  const input = 'glass-input text-sm py-2 w-full';
  return (
    <WizardFrame
      message={message}
      testSignal={testSignal}
      title="Sign in from other computers"
      status={check ? <StatusPill tone={check.passwordSet ? 'good' : 'idle'}>{check.passwordSet ? 'Password set' : 'No password'}</StatusPill> : <Loader2 className="w-3.5 h-3.5 animate-spin text-white/40" />}
      check={loadError ? <p className="text-xs text-yellow-300">{loadError}</p> : check ? (
        <ul className="text-xs text-white/70 flex flex-col gap-1">
          <li>This computer opens the dashboard without a password.</li>
          <li>{check.passwordSet ? `A password was set on ${check.setAt ? new Date(check.setAt).toLocaleDateString() : 'an earlier date'}; ${check.signedInBrowsers} browser${check.signedInBrowsers === 1 ? ' is' : 's are'} signed in.` : 'No password is set, so no other computer can sign in.'}</li>
          <li>{check.exposures.length ? `Other computers can reach it now: ${check.exposures.join('; ')}.` : 'Nothing lets other computers reach it yet.'}</li>
        </ul>
      ) : <p className="text-xs text-white/40">Reading…</p>}
      explain={<p className="text-xs text-white/60 leading-relaxed">Sets one password for the dashboard. Only browsers on other computers use it; this computer never asks. The password is stored scrambled (scrypt), five wrong guesses from one address pause sign-in for 15 minutes, and a signed-in browser cannot change the password. Remote access wizards need this first, and the app refuses to start with remote access on and no password.</p>}
      doIt={
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <button type="button" className="glass-button primary px-4 py-2 text-xs" disabled={busy !== null} onClick={() => void makeOne()}>
              {busy === 'set' && !pw ? 'Saving…' : check?.passwordSet ? 'Make a new password for me' : 'Make a strong password for me'}
            </button>
          </div>
          {madeBox}
          <details className="text-xs text-white/60">
            <summary className="cursor-pointer">Or choose your own</summary>
            <div className="flex flex-col gap-2 mt-2">
              <input type="password" className={input} placeholder="New password (12+ characters; a few words is fine)" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" aria-label="New password" />
              <input type="password" className={input} placeholder="Type it again" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" aria-label="New password again" />
              <div><button type="button" className="glass-button px-4 py-2 text-xs" disabled={busy !== null || !pw || !again} onClick={() => void setAndTest()}>
                {busy === 'set' && !!pw ? 'Saving…' : check?.passwordSet ? 'Change password and test it' : 'Set password and test it'}
              </button></div>
            </div>
          </details>
        </div>
      }
      prove={
        <div className="flex flex-col gap-2">
          {madeBox}
          <ProofList lines={proof} busy={busy === 'prove'} />
          {check?.passwordSet && <input type="password" className={input} placeholder="Your password, to test it again" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" aria-label="Password to test" />}
          {check?.passwordSet && <div><button type="button" className="glass-button px-3 py-1.5 text-xs" disabled={busy !== null} onClick={() => void retest()}>Test sign-in again</button></div>}
        </div>
      }
      undo={
        check?.passwordSet ? (
          confirmUndo ? (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-white/60">Remove the password and sign everyone out?</span>
              <button type="button" className="glass-button px-3 py-1.5 text-xs text-red-300" disabled={busy !== null} onClick={() => void undo()}>Yes, remove it</button>
              <button type="button" className="text-white/50 hover:text-white/80 px-2" onClick={() => setConfirmUndo(false)}>Keep it</button>
            </div>
          ) : (
            <div><button type="button" className="glass-button px-3 py-1.5 text-xs" disabled={busy !== null} onClick={() => setConfirmUndo(true)}>Remove password</button></div>
          )
        ) : <p className="text-xs text-white/40">Nothing to undo.</p>
      }
    />
  );
}
