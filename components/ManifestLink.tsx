'use client';

import { usePathname } from 'next/navigation';

import { manifestFor } from '@/lib/voice/install';

// The page's web app manifest. /voice links Riley Voice's own, so the browser installs it as a
// separate app; everything else keeps DevFlow's. Linked by hand with use-credentials: without it
// the browser fetches the manifest without the Cloudflare Access cookie, gets the login redirect,
// and cannot install the app.
export function ManifestLink() {
  return <link rel="manifest" href={manifestFor(usePathname())} crossOrigin="use-credentials" />;
}
