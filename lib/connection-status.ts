/** How a connection's status (as written in data/connections.json) is shown: the badge colour and the words. */
export function connectionBadge(status: string): { badge: string; label: string } {
  switch (status) {
    case 'active': return { badge: 'active', label: 'Active' };
    case 'configured': return { badge: 'configured', label: 'Key set' };
    case 'configured_not_active': return { badge: 'configured', label: 'Not in use' };
    case 'pending': return { badge: 'pending', label: 'Pending' };
    case 'needs_attention': return { badge: 'errored', label: 'Needs attention' };
    case 'needs_login': return { badge: 'warning', label: 'Needs sign-in' };
    case 'not_configured': return { badge: 'warning', label: 'Not configured' };
    case 'retired': return { badge: 'stopped', label: 'Retired' };
    default: return { badge: 'unknown', label: 'Unknown' };
  }
}

/** The words for how something signs in, from its `auth.method` (api_key becomes "API key"). */
export function authLabel(method?: string): string {
  if (!method) return '—';
  const known: Record<string, string> = { api_key: 'API key', oauth: 'OAuth', subscription: 'Subscription', service_account: 'Service account', service_principal: 'Service principal', ssh_key: 'SSH key', none: 'None', local: 'Local', password: 'Password' };
  return known[method] ?? method.charAt(0).toUpperCase() + method.slice(1).replace(/_/g, ' ');
}
