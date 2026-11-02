'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { KEY_PROVIDERS } from './provider-link';
import { LOGINS_CHANGED_EVENT, parseCredentials } from '@/lib/harness-auth';
import { UNKNOWN_SERVICE_STATUS, type ServiceId, type ServiceStatus } from './service-catalog';

export const CONNECTIONS_CHANGED_EVENT = 'openflow:connections-changed';
export function announceConnectionsChanged() { window.dispatchEvent(new Event(CONNECTIONS_CHANGED_EVENT)); }
const disconnected: ServiceStatus = { kind: 'disconnected', label: 'Not connected' };
const connected: ServiceStatus = { kind: 'connected', label: 'Connected' };
const configured: ServiceStatus = { kind: 'configured', label: 'Configured — not verified' };

/** Initial read plus user/action events. No background polling. */
export function useServiceStatuses() {
  const [statuses, setStatuses] = useState<Partial<Record<ServiceId, ServiceStatus>>>({});
  const controller = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    const read = async (url: string) => {
      const response = await fetch(url, { cache: 'no-store', signal: current.signal });
      if (!response.ok) throw new Error('Status unavailable');
      return response.json();
    };
    const update = (patch: Partial<Record<ServiceId, ServiceStatus>>) => { if (!current.signal.aborted) setStatuses(previous => ({ ...previous, ...patch })); };
    await Promise.allSettled([
      ...(['cloudflare', 'tailscale'] as const).map(async id => {
        try {
          const body = await read(`/api/wizards/${id}`);
          if (!body.success) throw new Error('Status unavailable');
          const active = id === 'cloudflare' ? body.record?.stage === 'live' : !!body.active;
          update({ [id]: active ? configured : disconnected });
        } catch { update({ [id]: UNKNOWN_SERVICE_STATUS }); }
      }),
      ...(['slack', 'teams', 'whatsapp'] as const).map(async id => {
        try {
          const body = await read(`/api/bridges/${id}${id === 'whatsapp' ? '' : '/status'}`);
          const state = id === 'whatsapp' ? body.status : body;
          update({ [id]: state?.connected === true || state?.status === 'connected' ? connected : (state?.configured || body.config?.enabled ? configured : disconnected) });
        } catch { update({ [id]: UNKNOWN_SERVICE_STATUS }); }
      }),
      (async () => {
        try {
          const body = await read('/api/supabase/instances');
          const instances = body.data?.instances;
          if (!Array.isArray(instances)) throw new Error('Invalid status');
          update({ supabase: instances.some(item => item.status === 'online') ? connected : instances.length ? configured : disconnected });
        } catch { update({ supabase: UNKNOWN_SERVICE_STATUS }); }
      })(),
      (async () => {
        try {
          const body = await read('/api/vault/sync-secrets');
          if (!body.success || !Array.isArray(body.envVars)) throw new Error('Invalid key status');
          update(Object.fromEntries(KEY_PROVIDERS.map(provider => [provider.id, body.envVars.includes(provider.secretName) ? { kind: 'configured', label: 'Key saved — not tested' } : disconnected])));
        } catch { update(Object.fromEntries(KEY_PROVIDERS.map(provider => [provider.id, UNKNOWN_SERVICE_STATUS]))); }
      })(),
      (async () => {
        try {
          const credentials = parseCredentials(true, await read('/api/system/harness-auth'));
          if (!credentials) throw new Error('Invalid login status');
          for (const harness of ['claude', 'codex'] as const) {
            const credential = credentials.find(item => item.id === `${harness}@desktop`);
            update({ [`${harness}-login`]: credential?.state === 'ok' ? { kind: 'connected', label: 'Signed in' } : credential?.state === 'needs_login' ? { kind: 'disconnected', label: 'Sign-in needed' } : UNKNOWN_SERVICE_STATUS });
          }
        } catch { update({ 'claude-login': UNKNOWN_SERVICE_STATUS, 'codex-login': UNKNOWN_SERVICE_STATUS }); }
      })(),
    ]);
  }, []);
  useEffect(() => {
    void refresh();
    const onChange = () => { void refresh(); };
    window.addEventListener(CONNECTIONS_CHANGED_EVENT, onChange);
    window.addEventListener(LOGINS_CHANGED_EVENT, onChange);
    window.addEventListener('focus', onChange);
    return () => {
      controller.current?.abort();
      window.removeEventListener(CONNECTIONS_CHANGED_EVENT, onChange);
      window.removeEventListener(LOGINS_CHANGED_EVENT, onChange);
      window.removeEventListener('focus', onChange);
    };
  }, [refresh]);
  return { statuses, refresh };
}
