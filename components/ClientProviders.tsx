'use client';

/**
 * ClientProviders - Wraps client-side providers for the entire app
 *
 * This component is used in the root layout to provide context
 * that persists across all pages (including /vault).
 *
 * Chat panel is overlay-based (fixed position) and doesn't affect DOM layout.
 */

import { ReactNode, useEffect, useState } from 'react';
import { ChatProvider } from '@/lib/contexts/ChatContext';
import { EventStreamProvider, useEventStreamContext } from '@/lib/contexts/EventStreamContext';
import { ToastProvider } from '@/lib/contexts/ToastContext';
import { ThemeProvider } from '@/lib/contexts/ThemeContext';
import { GlobalChatPanel } from './GlobalChatPanel';
import { Toaster } from './Toaster';
import { NewVersionPill } from './NewVersionPill';
import { PRODUCT_NAME } from '@/lib/brand';

interface ClientProvidersProps {
  children: ReactNode;
}

type WslStatus = 'ok' | 'degraded' | 'unknown';

function WslNetworkBanner() {
  const eventStream = useEventStreamContext();
  const [status, setStatus] = useState<WslStatus | null>(null);
  const [message, setMessage] = useState<string>('');
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    return eventStream.subscribe<{ status: WslStatus; message?: string }>('network:wsl-status', (data) => {
      setStatus(data.status);
      setMessage(data.message ?? '');
      if (data.status !== 'ok') setDismissed(false);
    });
  }, [eventStream]);

  if (!status || status === 'ok' || dismissed) return null;

  const isDegraded = status === 'degraded';

  return (
    <div
      className={`fixed top-0 left-0 right-0 z-[9999] flex items-center gap-3 px-4 py-2.5 text-sm font-medium shadow-lg ${
        isDegraded
          ? 'bg-amber-500/95 text-amber-950'
          : 'bg-red-600/95 text-white'
      }`}
      style={{ backdropFilter: 'blur(8px)' }}
    >
      <span className="flex-shrink-0 text-base">{isDegraded ? '⚠️' : '🔴'}</span>
      <span className="flex-1 truncate">
        {isDegraded
          ? `WSL2 network changed — Windows browser may lose access to ${PRODUCT_NAME}. If the page stops loading, check network-status.txt in the devflow-bridge folder of your Windows user profile`
          : `${PRODUCT_NAME} self-check failed — server may be unresponsive`}
        {message && <span className="ml-2 opacity-70 text-xs font-normal hidden md:inline">{message}</span>}
      </span>
      <button
        onClick={() => setDismissed(true)}
        className="flex-shrink-0 p-1 rounded opacity-70 hover:opacity-100 transition-opacity"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}

function ServiceWorkerRegistrar() {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }, []);
  return null;
}

export function ClientProviders({ children }: ClientProvidersProps) {
  return (
    <ThemeProvider>
      <EventStreamProvider>
        <ToastProvider>
          <ChatProvider>
            <ServiceWorkerRegistrar />
            <WslNetworkBanner />
            <NewVersionPill />
            {children}
            <GlobalChatPanel />
            <Toaster />
          </ChatProvider>
        </ToastProvider>
      </EventStreamProvider>
    </ThemeProvider>
  );
}
