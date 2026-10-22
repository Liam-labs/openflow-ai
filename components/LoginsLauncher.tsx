'use client';

import React, { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { useHarnessAuth } from '@/components/useHarnessAuth';
import { LoginsDialog } from '@/components/LoginsDialog';
import { needsAttention } from '@/lib/harness-auth';

/** Dock button that opens the Logins list. A dot shows when any login needs a person. */
export function LoginsLauncher() {
  const [open, setOpen] = useState(false);
  const { credentials } = useHarnessAuth(true, 30_000);
  const attention = (credentials ?? []).some(needsAttention);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="cs-dock-btn relative" title={attention ? 'Logins: one needs attention' : 'Logins'} aria-label={attention ? 'Logins, needs attention' : 'Logins'}>
        <KeyRound size={16} />
        {attention && <span className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-red-400" aria-hidden />}
      </button>
      {open && <LoginsDialog onClose={() => setOpen(false)} />}
    </>
  );
}
