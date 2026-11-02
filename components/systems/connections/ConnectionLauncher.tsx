'use client';
import { useState } from 'react';
import { ServiceLauncher } from './ServiceLauncher';
import type { ServiceId } from './service-catalog';
import { useServiceStatuses } from './useServiceStatuses';
import { SlackSetupWizard } from '@/components/SlackSetupWizard';
import { TeamsSetupWizard } from '@/components/TeamsSetupWizard';
import { WhatsAppSetupWizard } from '@/components/WhatsAppSetupWizard';
import { SupabaseConfigPanel } from '@/components/SupabaseConfigPanel';
import { HarnessSignInModal } from '@/components/modals/HarnessSignInModal';
import { keyProvider, PROVIDER_PREFIX } from './provider-link';
import type { SystemsNavState } from '../systems-types';

export function ConnectionLauncher({ onNavigate }: { onNavigate?: (state: Partial<SystemsNavState>) => void }) {
  const { statuses, refresh } = useServiceStatuses();
  const [open, setOpen] = useState<ServiceId | null>(null);
  const close = () => { setOpen(null); void refresh(); };
  function connect(id: ServiceId) {
    if (keyProvider(id)) onNavigate?.({ section: 'connections', entityId: PROVIDER_PREFIX + id, entityType: 'connection' });
    else if (id === 'cloudflare' || id === 'tailscale') onNavigate?.({ section: 'connections', entityId: id, entityType: 'connection' });
    else setOpen(id);
  }
  const bridge = open === 'slack' ? <SlackSetupWizard onComplete={close} onCancel={close} /> : open === 'teams' ? <TeamsSetupWizard onComplete={close} onCancel={close} /> : open === 'whatsapp' ? <WhatsAppSetupWizard onComplete={close} onCancel={close} /> : null;
  return <>
    <ServiceLauncher statuses={statuses} onConnect={connect} onRefresh={() => void refresh()} />
    {bridge && <div className="fixed inset-0 z-[150] overflow-y-auto bg-black/80 p-3 sm:p-6"><div className="mx-auto max-w-xl rounded-2xl border border-white/10 bg-[#0c1120] p-4 sm:p-6">{bridge}</div></div>}
    {open === 'supabase' && <SupabaseConfigPanel onClose={close} />}
    {(open === 'claude-login' || open === 'codex-login') && <HarnessSignInModal credentialId={open === 'claude-login' ? 'claude@desktop' : 'codex@desktop'} onClose={close} onChanged={() => void refresh()} simple eventDriven />}
  </>;
}
