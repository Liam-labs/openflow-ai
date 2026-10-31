'use client';

import { Suspense, useMemo, useState } from 'react';
import { notFound, useSearchParams } from 'next/navigation';
import { AddressStep } from '@/components/setup/AddressStep';
import { SCENARIOS, makeMockService, type Scenario } from './mock-service';

/** Development preview of the address step against a pretend backend. Not served in production. */
function Preview() {
  const params = useSearchParams();
  const asked = params.get('scenario') as Scenario | null;
  const scenario: Scenario = asked && SCENARIOS.includes(asked) ? asked : 'free';
  const service = useMemo(() => makeMockService(scenario), [scenario]);
  const [address, setAddress] = useState<string | null>(null);

  return (
    <div className="w-full max-w-2xl">
      <p className="text-xs text-white/40 mb-3">
        Preview, scenario: {SCENARIOS.map((s) => (
          <a key={s} href={`?scenario=${s}`} className={`mr-3 underline ${s === scenario ? 'text-white' : ''}`}>{s}</a>
        ))}
      </p>
      {address ? (
        <div className="glass-card p-8" role="status">
          <p className="text-white">Done. The next step would use: {address}</p>
        </div>
      ) : (
        <AddressStep key={scenario} service={service} onDone={setAddress} portHintAfterMs={4000} />
      )}
    </div>
  );
}

export default function AddressStepPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <div className="min-h-screen bg-[#050510] flex items-center justify-center px-4 py-12">
      <Suspense fallback={null}>
        <Preview />
      </Suspense>
    </div>
  );
}
