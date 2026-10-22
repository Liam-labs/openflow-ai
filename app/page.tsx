'use client';

import { Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { ColabPanel } from '@/components/ColabPanel';

function HomeContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const channelId = searchParams.get('channel');

  return (
    <ColabPanel
      isOpen={true}
      onClose={() => router.push('/operations')}
      initialChannelId={channelId}
      mode="page"
    />
  );
}

export default function Home() {
  return (
    <Suspense>
      <HomeContent />
    </Suspense>
  );
}
