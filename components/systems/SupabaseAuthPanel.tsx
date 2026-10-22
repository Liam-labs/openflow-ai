'use client';

import React, { useState, useEffect } from 'react';
import { Users, ExternalLink, Lock } from 'lucide-react';
import type { SupabaseInstance } from '@/lib/supabase-types';
import { getSupabaseAuthUsersUrl } from '@/lib/supabase-instance-links';

interface Props { instanceId: string; }

export function SupabaseAuthPanel({ instanceId }: Props) {
  const [instance, setInstance] = useState<SupabaseInstance | null>(null);

  useEffect(() => {
    fetch('/api/supabase/instances')
      .then(r => r.json())
      .then(d => {
        const instances: SupabaseInstance[] = d.data?.instances ?? [];
        setInstance(instances.find(i => i.id === instanceId) ?? null);
      })
      .catch(() => {});
  }, [instanceId]);

  const authUrl = instance
    ? getSupabaseAuthUsersUrl(instance)
    : 'https://supabase.com/dashboard';

  return (
    <div className="sba-coming-soon">
      <div className="sba-cs__icon"><Lock size={28} strokeWidth={1.5} /></div>
      <p className="sba-cs__title">Auth Management</p>
      <p className="sba-cs__hint">User management coming soon. Manage auth directly in Supabase.</p>
      <a
        href={authUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="sba-cs__link"
      >
        <Users size={13} />
        Open Auth Users
        <ExternalLink size={11} />
      </a>
    </div>
  );
}
