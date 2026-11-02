import { KEY_PROVIDERS } from './provider-link';

/** Always present, even before the first credential or saved connection exists. */
export const SERVICE_CATALOG = [
  { id: 'cloudflare', name: 'Cloudflare', category: 'Network', description: 'Use your own domain with a Cloudflare tunnel and email sign-in.' },
  { id: 'tailscale', name: 'Tailscale', category: 'Network', description: 'Reach OpenFlow privately from your phone or laptop.' },
  { id: 'slack', name: 'Slack', category: 'Messaging', description: 'Talk with your agents from a Slack workspace.' },
  { id: 'teams', name: 'Microsoft Teams', category: 'Messaging', description: 'Connect your agents to Microsoft Teams.' },
  { id: 'whatsapp', name: 'WhatsApp', category: 'Messaging', description: 'Pair your phone to message your agents.' },
  { id: 'supabase', name: 'Supabase', category: 'Database', description: 'Connect a hosted or self-managed database.' },
  { id: 'claude-login', name: 'Claude subscription', category: 'AI providers', description: 'Sign in with your Claude subscription.' },
  { id: 'codex-login', name: 'Codex subscription', category: 'AI providers', description: 'Sign in with your ChatGPT subscription.' },
  ...KEY_PROVIDERS.map(provider => ({ id: provider.id, name: provider.label, category: 'AI providers', description: `Add an API key for ${provider.label}.` })),
] as const;

export type ServiceId = typeof SERVICE_CATALOG[number]['id'];
export type ServiceStatus = { label: string; kind: 'unknown' | 'pending' | 'connected' | 'configured' | 'error' | 'disconnected' };
export const UNKNOWN_SERVICE_STATUS: ServiceStatus = { label: 'Status unavailable', kind: 'unknown' };
