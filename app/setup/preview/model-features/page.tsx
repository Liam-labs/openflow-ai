'use client';

import { Suspense, useMemo } from 'react';
import { notFound, useSearchParams } from 'next/navigation';
import { ModelFeatureCard } from '@/components/model-features/ModelFeatureCard';
import { makePreviewClient, type PreviewScenario } from './mock-client';

/** Development preview of ModelFeatureCard against a pretend backend. Not served in production. */
function Preview() {
  const params = useSearchParams();
  const scenario = (['normal', 'not-ready', 'slow'] as const).find((s) => s === params.get('scenario')) ?? 'normal';
  // "linked" stands in for the key page: arriving with it means the person saved that provider's key.
  const linked = useMemo(() => ['beta', ...(params.get('linked') ? [params.get('linked') as string] : [])], [params]);
  const client = useMemo(() => makePreviewClient(scenario as PreviewScenario, linked), [scenario, linked]);

  return (
    <div className="w-full max-w-2xl flex flex-col gap-6">
      <p className="text-xs text-white/40">
        Preview, scenario:{' '}
        {['normal', 'not-ready', 'slow'].map((s) => (
          <a key={s} href={`?scenario=${s}`} className={`mr-3 underline ${s === scenario ? 'text-white' : ''}`}>
            {s}
          </a>
        ))}
        Linked: {linked.join(', ')}. Key page: choose alpha, switch on, press Add the key.
      </p>
      <ModelFeatureCard featureId="knowledge-update" client={client} />
      <ModelFeatureCard featureId="overwatch" client={client} />
    </div>
  );
}

export default function ModelFeaturePreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <div className="min-h-screen bg-[#050510] flex items-start justify-center px-4 py-10">
      <Suspense fallback={null}>
        <Preview />
      </Suspense>
    </div>
  );
}
