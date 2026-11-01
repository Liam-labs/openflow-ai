'use client';

import { useEffect, useState } from 'react';
import { Globe, Loader2 } from 'lucide-react';
import { parseInstallAddressResult, type InstallAddressResult } from '@/lib/setup/install-address';

/** Read the installer's outcome. This component never requests or changes a name. */
export function InstallAddress() {
  const [result, setResult] = useState<InstallAddressResult | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function read() {
      try {
        const response = await fetch('/api/setup/address', { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('Could not read installer result');
        const next = parseInstallAddressResult(await response.json());
        if (controller.signal.aborted) return;
        setResult(next);
        setError(false);
        if (next.serverMode && (!next.address || ['claiming', 'certificate'].includes(next.address.state))) timer = setTimeout(read, 2000);
      } catch {
        if (!controller.signal.aborted) setError(true);
      }
    }
    void read();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [attempt]);

  if (result?.serverMode === false) return null;
  const address = result?.address;
  const ready = !error && address?.state === 'ready';
  const failed = !error && address?.state === 'failed';
  const pending = !error && !ready && !failed;

  return <section className="glass-card p-4 sm:p-5 mb-6 min-w-0" aria-labelledby="install-address-heading">
    <h2 id="install-address-heading" className="flex items-center gap-2 text-base font-semibold text-white"><Globe size={18} aria-hidden="true" />Your OpenFlow address</h2>
    <div className="mt-3 text-sm text-white/70" aria-live="polite">
      {error ? <>
        <p role="alert">We could not read your installer’s address. Your setup details are still here.</p>
        <button type="button" className="glass-button mt-3 px-4 py-2" onClick={() => { setError(false); setAttempt(value => value + 1); }}>Try again</button>
      </> : <>
        {pending && <p role="status" className="flex items-start gap-2"><Loader2 size={16} className="animate-spin shrink-0 mt-0.5" aria-hidden="true" />{address?.state === 'certificate' ? 'Your installer is securing your address.' : 'Your installer is preparing your address automatically.'}</p>}
        {failed && <div role="alert"><p>Your installer could not finish setting up your address.</p>{address?.reason && <p className="mt-2 break-words">Reason: {address.reason}</p>}<p className="mt-2">Check the installer result before retrying.</p><button type="button" className="glass-button mt-3 px-4 py-2" onClick={() => setAttempt(value => value + 1)}>Check again</button></div>}
        {address?.url && <p className="mt-2 break-all">{ready ? <a href={address.url} className="text-blue-300 underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-400">{address.url}</a> : <span>{address.url}</span>}</p>}
        {ready && <p className="mt-2">Save this address to return to OpenFlow.</p>}
        {address?.source === 'fallback' && address.reason === 'unreachable' && <p className="mt-2">The names service could not be reached. Your installer is using this fallback address.</p>}
        {ready && address?.url?.startsWith('http:') && <p className="mt-2">This address does not have HTTPS yet.</p>}
      </>}
    </div>
  </section>;
}
