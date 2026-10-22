import type { Metadata } from "next";
import "./globals.css";
import "./fonts-local.css";
import "./midnight-glass.css";
import "./midnight-glass-team.css";
import "./midnight-glass-navbar.css";
import "./midnight-glass-board.css";
import { ClientProviders } from "@/components/ClientProviders";
import { ManifestLink } from '@/components/ManifestLink';
import { PRODUCT_NAME } from '@/lib/brand';

// DevFlow is a fully dynamic dashboard — no pages should be statically prerendered.
// This prevents React 19 + webpack SSR prerender errors on all child routes.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: `${PRODUCT_NAME} - AI agent workspace`,
  description: "Monitor and manage your development projects and environments",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: PRODUCT_NAME,
  },
  icons: {
    apple: "/icons/apple-touch-icon.png",
  },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  interactiveWidget: 'resizes-content',
  // Installed Android PWAs draw edge-to-edge behind the gesture bar (Chrome 135+);
  // without 'cover' env(safe-area-inset-bottom) stays 0 and the chat composer is
  // hidden under the bar (owner, 30 Sep 2026). Chrome only extends at the bottom.
  viewportFit: 'cover',
  themeColor: '#060b14',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <head>
        {/* Linked by hand (see ManifestLink): DevFlow's manifest everywhere except /voice,
            which installs as its own "Riley Voice" app. */}
        <ManifestLink />
      </head>
      <body
        className="font-sans antialiased"
      >
        <div className="bg-gradient" />
        <ClientProviders>
          {children}
        </ClientProviders>
      </body>
    </html>
  );
}
