/**
 * Recognises a Cloudflare API token on the clipboard. Tokens made since 2026 are `cfut_` (user) or `cfat_` (account), then 40
 * characters and an 8-character checksum (developers.cloudflare.com/fundamentals/api/get-started/token-formats). Older tokens are
 * the bare 40 characters. A global API key (`cfk_`) is not a token and is never picked up.
 */
export function looksLikeCloudflareToken(text: unknown): text is string {
  return typeof text === 'string' && /^(?:cf(?:ut|at)_[A-Za-z0-9_-]{48}|[A-Za-z0-9_-]{40})$/.test(text.trim());
}
