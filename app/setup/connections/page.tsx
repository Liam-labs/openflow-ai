'use client';

import { useState } from 'react';
import { SetupEntry } from '@/components/setup/SetupEntry';
import { ConnectionsSection } from '@/components/systems/ConnectionsSection';
import { ConnectionDetail } from '@/components/systems/ConnectionDetail';
import type { SystemsNavState } from '@/components/systems/systems-types';

export default function SetupConnectionsPage() {
  const [selection, setSelection] = useState<Partial<SystemsNavState>>({});
  return <main className="min-h-screen bg-[#050510] p-4 text-white sm:p-8"><div className="mx-auto max-w-6xl">
    <a href="/setup" className="mb-6 mr-4 inline-block py-3 text-blue-300 underline">Return to setup</a>
    <SetupEntry nextPath="/setup/connections">
      {selection.entityId ? <><button className="glass-button mb-4 px-4 py-3" onClick={() => setSelection({})}>All connections</button><ConnectionDetail connectionId={selection.entityId} isMcp={selection.entityType === 'mcp-server'} /></> : <ConnectionsSection onNavigate={setSelection} />}
    </SetupEntry>
  </div></main>;
}
