import type { NextConfig } from "next";
import path from "path";
import { CHANNEL_TOOL_CSP } from "./lib/channel-tool-csp";

const nextConfig: NextConfig = {
  // One setting for the owner's name (lib/human-identity.ts): DEVFLOW_OWNER_NAME at build time, inlined for server and browser alike.
  env: {
    NEXT_PUBLIC_DEVFLOW_PROJECT_NAME: process.env.DEVFLOW_PROJECT_NAME || process.env.NEXT_PUBLIC_DEVFLOW_PROJECT_NAME || '',
    NEXT_PUBLIC_DEVFLOW_OWNER_NAME: process.env.DEVFLOW_OWNER_NAME || process.env.NEXT_PUBLIC_DEVFLOW_OWNER_NAME || '',
    // Browser code cannot read HOME: the build's home folder and DevFlow checkout are inlined for lib/home-dir.ts.
    NEXT_PUBLIC_DEVFLOW_HOME_DIR: process.env.HOME ?? process.env.USERPROFILE ?? '',
    NEXT_PUBLIC_DEVFLOW_HOME: process.env.DEVFLOW_HOME ?? '',
  },

  // Allow builds to target a staging directory for atomic swaps
  // Production server always reads from .next (the default)
  distDir: process.env.NEXT_BUILD_DIR || '.next',

  // DevFlow runs from the repo under pm2, not as a standalone bundle, so file
  // traces are never read at runtime. Pin the root (a stray ~/package-lock.json
  // made Next trace from $HOME, pulling in ~/.codex and ~/.claude) and skip
  // runtime data: tracing ~100k .AppData files per route pushed the build past
  // 5 GB RSS. Patterns must stay inside the root; Turbopack rejects '../'.
  outputFileTracingRoot: __dirname,
  outputFileTracingExcludes: {
    '*': [
      '.AppData/**',
      'data/**',
      'logs/**',
      'archive/**',
      '.next-old/**',
      '.next-staging/**',
      '.next-ready/**',
    ],
  },

  // chokidar loads fsevents (a native macOS addon) by itself when it is present. Bundling it breaks the macOS build
  // ("non-ecmascript placeable asset"), so both stay as plain require()s at run time. Harmless on Linux.
  serverExternalPackages: ['chokidar', 'fsevents'],

  // DevFlow never uses next/image, so the /_next/image optimiser (the target of the Next <=16.4.0 image-optimisation
  // remote-code advisory) is switched off: nothing needs it, and it removes that attack surface even on a future Next advisory.
  images: { unoptimized: true },

  // Enable gzip compression — reduces API response sizes ~80% over webgate tunnel
  compress: true,

  experimental: {
    // Limit build workers to 12 (default = CPU count = 24).
    // Prevents OOM when agents are running alongside builds; lower it with
    // DEVFLOW_BUILD_CPUS when agent workloads leave less memory free.
    cpus: Number.parseInt(process.env.DEVFLOW_BUILD_CPUS ?? '', 10) > 0
      ? Number.parseInt(process.env.DEVFLOW_BUILD_CPUS ?? '', 10)
      : 12,
  },

  // AgentChat is the home page; old /collab links (bookmarks, installed app, agent messages) keep working.
  async redirects() {
    return [
      { source: '/collab', destination: '/', permanent: false },
      // The PA system used to be called Life Admin: a real 308 so old links and tools that skip scripts still arrive.
      { source: '/life-admin', destination: '/pa', permanent: true },
    ];
  },

  async headers() {
    return [
      {
        // Apply to all routes
        source: '/(.*)',
        headers: [
          // Prevent MIME-type sniffing
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // Prevent clickjacking — only allow framing from same origin
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          // Limit referrer info sent to cross-origin requests
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // Disable browser APIs not used by the dashboard
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          // CSP: baseline same-origin policy with carve-outs required by Next.js
          // - unsafe-inline + unsafe-eval: Next.js runtime and HMR require both
          // - data:/blob:: collab screenshots, ECharts worker blobs, embedded fonts
          // - https: externally sourced design-reference preview images (no-referrer in UI)
          // - ws:/wss:: SSE + HMR WebSocket connections
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob: https:",
              "font-src 'self' data:",
              "connect-src 'self' ws: wss:",
              "worker-src 'self' blob:",
              "frame-ancestors 'self'",
            ].join('; '),
          },
          // Prevent Cloudflare/CDN from caching HTML pages for 1 year (Next.js default s-maxage)
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
        ],
      },
      {
        // Channel tool pages (served from a channel's channel-tools folder): sandboxed, opaque origin.
        // Declared after the global rule so its CSP replaces the global one for these files only.
        source: '/api/channel-tools/file/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: CHANNEL_TOOL_CSP },
        ],
      },
      {
        // Design kit files (preview, fonts, example pages): sandboxed like channel tool pages, so a kit's example cannot reach DevFlow.
        source: '/api/design-kits/:id/file/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: CHANNEL_TOOL_CSP },
        ],
      },
      {
        // Allow long-term caching for static assets (they have content-hash filenames)
        source: '/_next/static/(.*)',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
        ],
      },
    ];
  },

  webpack: (config, { dev, isServer, nextRuntime }) => {
    // Node.js built-ins (crypto, os, path, fs) used in server-only code (api-auth.ts,
    // collab-pty.ts etc.) cause "Module not found" errors when webpack compiles
    // instrumentation.ts for the edge runtime. Apply ONLY to edge runtime — the Node.js
    // server bundle resolves them natively; applying to client bundle breaks React SSR.
    if (nextRuntime === 'edge') {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        crypto: false,
        os: false,
        path: false,
        fs: false,
        net: false,
        tls: false,
        child_process: false,
        zlib: false,
        stream: false,
        'stream/promises': false,
        buffer: false,
        util: false,
        events: false,
        assert: false,
        http: false,
        https: false,
        url: false,
        querystring: false,
        string_decoder: false,
        fsevents: false,
        'webworker-threads': false,
      };
    }

    // No persistent cache for production builds. The filesystem cache grew to
    // 2.9 GB, was loaded into the compiler on every build and still left builds
    // at 20-26 min (Sep 2026 logs); it also was invalidated by every config edit.
    // Its memory cost got builds OOM-killed while agents were running.
    if (!dev) {
      config.cache = false;
    }
    // The persistent cache reused a stale compile of the Tailwind entry
    // (app/globals.css) even after it changed, so CSS edits never shipped.
    // Always recompile that one module; see scripts/webpack-uncacheable-loader.cjs.
    config.module.rules.push({
      test: /[\\/]app[\\/]globals\.css$/,
      enforce: 'pre',
      use: [path.join(__dirname, 'scripts', 'webpack-uncacheable-loader.cjs')],
    });

    if (dev) {
      // Prevent Fast Refresh from triggering on non-source file changes.
      // .AppData/ has collab-channels.json, collab-messages/, crash-logs/ — written constantly by agents.
      // data/ has earlyoom-events.json, connections.json, etc.
      // logs/ has earlyoom-output.log, browser-agent logs.
      // scripts/ has helper scripts that don't need HMR.
      config.watchOptions = {
        ...config.watchOptions,
        ignored: [
          '**/node_modules/**',
          '**/.next/**',
          '**/.git/**',
          '**/.AppData/**',
          '**/data/**',
          '**/logs/**',
          '**/scripts/**',
          '**/Team/**',
        ],
      };
    }
    return config;
  },
};

export default nextConfig;
