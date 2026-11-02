/** A Cloudflare API token is 40 characters of letters, digits, dash and underscore. Used to recognise one on the clipboard. */
export function looksLikeCloudflareToken(text: unknown): text is string {
  return typeof text === 'string' && /^[A-Za-z0-9_-]{40}$/.test(text.trim());
}
