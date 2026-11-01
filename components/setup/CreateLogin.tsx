'use client';

import { useRef, useState, type FormEvent } from 'react';
import { Loader2, LockKeyhole } from 'lucide-react';

export interface CreateLoginProps {
  createLogin: (code: string, password: string) => Promise<{ ok: boolean; error?: string; signInRequired?: boolean }>;
  onCreated: () => void;
}

/** The installer supplies the one-time code. Secrets live only in this form. */
export function CreateLogin({ createLogin, onCreated }: CreateLoginProps) {
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [signInRequired, setSignInRequired] = useState(false);
  const busy = useRef(false);
  const errorRef = useRef<HTMLParagraphElement>(null);

  const fail = (message: string) => {
    setError(message);
    requestAnimationFrame(() => errorRef.current?.focus());
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return;
    if (!code.trim()) return fail('Enter the setup code from your installer.');
    if (password.length < 12 || password.length > 256) return fail('Use a password with 12 to 256 characters.');
    if (password !== confirmation) return fail('The passwords do not match. Enter the same password in both fields.');
    busy.current = true;
    setSaving(true);
    setError('');
    try {
      const result = await createLogin(code.trim(), password);
      if (!result.ok) {
        setSignInRequired(result.signInRequired === true);
        fail(result.error || 'We could not create your login. Try again.');
        return;
      }
      setCode('');
      setPassword('');
      setConfirmation('');
      onCreated();
    } catch {
      fail('We could not reach your server. Check your connection, then try again.');
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }

  return (
    <section className="glass-card p-5 sm:p-8" aria-labelledby="create-login-title">
      <div className="flex items-center gap-3 mb-5">
        <LockKeyhole className="w-6 h-6 text-blue-400 shrink-0" aria-hidden="true" />
        <h1 id="create-login-title" className="text-xl font-semibold text-white">Create your login</h1>
      </div>
      <p className="text-sm text-white/70 mb-6">Protect your OpenFlow server with a password. You will use it to sign in from your other devices.</p>
      <form onSubmit={submit} className="flex flex-col gap-5" aria-busy={saving}>
        <div className="flex flex-col gap-2">
          <label htmlFor="setup-code" className="text-sm text-white/80">Setup code</label>
          <input id="setup-code" name="setupCode" type="password" autoComplete="one-time-code" spellCheck={false} autoCapitalize="none" className="glass-input w-full min-w-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400" value={code} onChange={(e) => setCode(e.target.value)} required disabled={saving} aria-describedby="setup-code-help" />
          <p id="setup-code-help" className="text-sm text-white/60">Paste the one-time code shown by your installer. Keep it private.</p>
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor="setup-password" className="text-sm text-white/80">Choose a password</label>
          <input id="setup-password" name="newPassword" type="password" autoComplete="new-password" className="glass-input w-full min-w-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={12} maxLength={256} disabled={saving} aria-describedby="setup-password-help" />
          <p id="setup-password-help" className="text-sm text-white/60">Use at least 12 characters. A few ordinary words in a row is fine.</p>
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor="setup-password-confirm" className="text-sm text-white/80">Repeat your password</label>
          <input id="setup-password-confirm" name="confirmPassword" type="password" autoComplete="new-password" className="glass-input w-full min-w-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} required minLength={12} maxLength={256} disabled={saving} />
        </div>
        {error && <p ref={errorRef} tabIndex={-1} role="alert" className="text-sm text-red-300 break-words">{error}</p>}
        {signInRequired && <a href="/login?next=%2Fsetup" className="text-blue-300 underline">Sign in to continue setup</a>}
        <button type="submit" disabled={saving} className="glass-button flex items-center justify-center gap-2 px-5 py-3 text-white disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400">
          {saving && <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
          {saving ? 'Creating your login…' : 'Create login and continue'}
        </button>
      </form>
    </section>
  );
}
