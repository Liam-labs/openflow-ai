/**
 * Download Filename Sanitizer
 *
 * Sanitizes user-supplied filenames before they land in a Content-Disposition
 * header. Defends against:
 *   - Header injection (CR/LF/control chars)
 *   - Path traversal (../, /, \)
 *   - Hidden-file confusion (leading dot)
 *   - Length-based DoS / filesystem-name limit overruns
 *
 * Returns the sanitized filename, or `null` if the input cannot be safely
 * rendered (empty, all-stripped, traversal pattern, etc.). Callers must treat
 * `null` as "omit the filename attribute from Content-Disposition entirely".
 *
 * Use case: GET /api/collab/images/[id]?name=<original> — the UI passes the
 * user-visible filename so the browser saves the file under that name instead
 * of the storage UUID.
 */

const MAX_FILENAME_BYTES = 255;
const ALLOWED_CHAR_RE = /[a-zA-Z0-9._\- ]/;

export function sanitizeDownloadFilename(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  // Reject path-traversal markers anywhere in the input — even if the rest
  // sanitizes cleanly, the presence of `..` or a slash is an attempt we don't
  // want to silently rewrite into something innocuous.
  if (input.includes('..') || input.includes('/') || input.includes('\\')) return null;

  let out = '';
  for (const ch of input) {
    const code = ch.charCodeAt(0);
    // Strip ASCII control characters (including CR/LF/TAB) — these are the
    // primary header-injection vector.
    if (code < 0x20 || code === 0x7f) continue;
    if (ALLOWED_CHAR_RE.test(ch)) {
      out += ch;
    } else {
      out += '_';
    }
  }

  // Collapse runs of underscores produced by the replacement above so a
  // pathological input doesn't end up as a long string of underscores.
  out = out.replace(/_{2,}/g, '_');
  // Trim leading/trailing whitespace and underscores.
  out = out.replace(/^[\s_]+|[\s_]+$/g, '');

  // Ban leading dot — prevents the browser from saving a hidden file the user
  // can't easily see in their Downloads folder.
  while (out.startsWith('.')) out = out.slice(1);

  if (out.length === 0) return null;

  // Cap by byte length (UTF-8). Truncating mid-codepoint would corrupt the
  // string, so we step back until the encoding is valid.
  let bytes = Buffer.byteLength(out, 'utf-8');
  if (bytes > MAX_FILENAME_BYTES) {
    // Preserve the extension if there is one, since downstream tools (and
    // users) rely on it. Find the last dot that has a "reasonable" extension.
    const lastDot = out.lastIndexOf('.');
    let ext = '';
    if (lastDot > 0 && out.length - lastDot <= 16) {
      ext = out.slice(lastDot);
    }
    const stemBudget = MAX_FILENAME_BYTES - Buffer.byteLength(ext, 'utf-8');
    let stem = out.slice(0, lastDot >= 0 && ext ? lastDot : out.length);
    while (Buffer.byteLength(stem, 'utf-8') > stemBudget) {
      stem = stem.slice(0, -1);
    }
    out = stem + ext;
    bytes = Buffer.byteLength(out, 'utf-8');
    if (bytes === 0 || stem.length === 0) return null;
  }

  return out;
}

/**
 * Build a Content-Disposition header value for a download response.
 *
 * If `name` is non-null, emits both `filename=` (ASCII-quoted) and
 * `filename*=UTF-8''` (RFC 5987 percent-encoded) so unicode names land
 * correctly across browsers. If `name` is null, returns just `attachment`
 * with no filename — letting the client-side `download` attribute supply
 * the name.
 */
export function buildContentDisposition(name: string | null): string {
  if (name === null) return 'attachment';
  // Quoted filename for legacy clients — escape backslash and double-quote.
  const quoted = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  // RFC 5987 encoded for unicode-aware clients.
  const encoded = encodeURIComponent(name);
  return `attachment; filename="${quoted}"; filename*=UTF-8''${encoded}`;
}
