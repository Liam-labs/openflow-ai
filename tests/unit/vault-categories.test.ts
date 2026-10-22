import { describe, expect, it } from 'vitest';
import {
  VAULT_CATEGORY_OPTIONS,
  isWebhookCategory,
  normalizeVaultCategory,
} from '@/lib/vault/categories';

describe('vault category helpers', () => {
  it('keeps the new public token and webhook categories available', () => {
    expect(VAULT_CATEGORY_OPTIONS).toContain('Public Access Tokens');
    expect(VAULT_CATEGORY_OPTIONS).toContain('Webhook');
  });

  it('normalizes legacy token labels to Public Access Tokens', () => {
    expect(normalizeVaultCategory('Tokens')).toBe('Public Access Tokens');
    expect(normalizeVaultCategory(' public access token ')).toBe('Public Access Tokens');
  });

  it('normalizes webhook aliases and detects webhook categories', () => {
    expect(normalizeVaultCategory('webhooks')).toBe('Webhook');
    expect(isWebhookCategory('Webhook')).toBe(true);
    expect(isWebhookCategory('API Keys')).toBe(false);
  });
});
