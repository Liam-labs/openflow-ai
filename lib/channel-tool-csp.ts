/**
 * Content-Security-Policy for pages served from a channel's html tools. `sandbox` without `allow-same-origin`
 * gives the page an opaque origin, so it cannot use DevFlow's cookies, storage or pages. Used by next.config.ts
 * (the only place that wins over the global CSP rule) and by the file route.
 */
export const CHANNEL_TOOL_CSP = [
  'sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads',
  "default-src 'self' data: blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-ancestors 'self'",
].join('; ');
