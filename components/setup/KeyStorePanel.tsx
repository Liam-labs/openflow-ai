'use client';

/**
 * "Where should OpenFlow keep your keys?" on the AI access step. One choice works today (this computer, encrypted) and is saved the
 * moment the panel loads, so the person has nothing to do unless they want to look. A password manager is shown as an optional later
 * choice that cannot be picked yet. If the app was started with its own key source (the environment), the panel says so.
 */

import { useEffect, useState } from 'react';
import { Lock, ChevronDown } from 'lucide-react';

interface Option { id: string; label: string; description: string; available: boolean; note?: string }
interface State { choice: string; active: { kind: string; encrypted: boolean }; options: Option[] }

export function KeyStorePanel() {
  const [state, setState] = useState<State | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/setup/key-store', { cache: 'no-store' });
        const json = await res.json();
        if (!alive || !res.ok || !json.success || typeof json.choice !== 'string' || !json.active || !Array.isArray(json.options)) return;
        setState({ choice: json.choice, active: json.active, options: json.options });
        // The default is the only working choice, so it is saved without asking.
        const post = await fetch('/api/setup/key-store', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ store: json.choice }) });
        if (alive && post.ok) setSaved(true);
      } catch { /* the panel is a convenience: without it the keys are still kept the same way */ }
    })();
    return () => { alive = false; };
  }, []);

  const choose = async (id: string) => {
    setError('');
    try {
      const res = await fetch('/api/setup/key-store', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ store: id }) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.success === false) { setError(typeof json.error === 'string' ? json.error : 'That could not be saved.'); return; }
      setState((s) => (s ? { ...s, choice: id } : s));
      setSaved(true);
    } catch {
      setError('Could not reach the server.');
    }
  };

  if (!state) return null;
  const fromEnvironment = state.active.kind === 'env';

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 mb-6" data-testid="key-store-panel">
      <div className="flex items-start gap-3">
        <Lock className="w-4 h-4 mt-0.5 flex-shrink-0 text-[#60a5fa]" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-white">Where OpenFlow keeps your keys</h3>
          <p className="text-xs text-white/60 mt-1 leading-relaxed">
            {fromEnvironment
              ? 'This install was started with its own key source, so OpenFlow reads your keys from the environment and never writes them.'
              : 'On this computer, in a private file that is encrypted. Nothing is sent anywhere except to the provider a key belongs to.'}
            {saved && !fromEnvironment ? ' Saved.' : ''}
          </p>
          {!fromEnvironment && (
            <>
              <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open}
                className="mt-2 inline-flex items-center gap-1 text-xs text-[#60a5fa] underline underline-offset-2"
              >
                See the choices <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
              </button>
              {open && (
                <fieldset className="mt-3 flex flex-col gap-2">
                  <legend className="sr-only">Where should OpenFlow keep your keys?</legend>
                  {state.options.map((o) => (
                    <label
                      key={o.id}
                      className={`flex items-start gap-2.5 rounded-lg border p-3 ${o.available ? 'border-white/15 cursor-pointer' : 'border-white/10 opacity-70'}`}
                    >
                      <input
                        type="radio"
                        name="key-store"
                        value={o.id}
                        checked={state.choice === o.id}
                        disabled={!o.available}
                        onChange={() => void choose(o.id)}
                        className="mt-1 accent-blue-500"
                      />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-white">{o.label}</span>
                        <span className="block text-xs text-white/60 mt-0.5">{o.description}</span>
                        {o.note && <span className="block text-xs text-amber-200/90 mt-1">{o.note}</span>}
                      </span>
                    </label>
                  ))}
                </fieldset>
              )}
              {error && <p role="alert" className="text-xs text-red-300 mt-2">{error}</p>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
