/**
 * Canonical vault category helpers.
 *
 * Keeps legacy labels working while steering new entries toward the current
 * names used in the vault UI.
 */

export const VAULT_CATEGORY_OPTIONS = [
  'API Keys',
  'Public Access Tokens',
  'Webhook',
  'SSH Keys',
  'OAuth',
  'Database',
  'Cloud',
  'Websites',
  'Payments',
] as const;

const CATEGORY_ALIASES: Record<string, string> = {
  tokens: 'Public Access Tokens',
  'public access token': 'Public Access Tokens',
  'public access tokens': 'Public Access Tokens',
  webhook: 'Webhook',
  webhooks: 'Webhook',
};

/**
 * Normalize a user-entered category into the canonical display value.
 * Preserves custom categories as-is.
 */
export function normalizeVaultCategory(category?: string | null): string {
  const trimmed = category?.trim();
  if (!trimmed) return '';

  const canonical = CATEGORY_ALIASES[trimmed.toLowerCase()];
  return canonical || trimmed;
}

export function isWebhookCategory(category?: string | null): boolean {
  return normalizeVaultCategory(category) === 'Webhook';
}
