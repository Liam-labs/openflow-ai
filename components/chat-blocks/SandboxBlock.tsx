'use client';

import React, { useRef, useEffect, useMemo } from 'react';

interface SandboxBlockProps {
  code: string;
}

const SANDBOX_SIZE_CAP = 200_000; // 200KB

// Wrap an HTML fragment in a minimal document shell if needed
function ensureHtmlDocument(code: string): string {
  if (/<html/i.test(code)) return code;
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body>${code}</body>
</html>`;
}

export default function SandboxBlock({ code }: SandboxBlockProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // Compute srcdoc and oversized before any hooks so hook order is stable
  const oversized = code.length > SANDBOX_SIZE_CAP;
  const srcdoc = useMemo(() => (oversized ? '' : ensureHtmlDocument(code)), [code, oversized]);

  useEffect(() => {
    if (oversized) return;
    // postMessage resize handler — only accept messages from our iframe's
    // contentWindow to prevent spoofing from other frames on the page
    const handler = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      if (e.data?.type === 'resize' && typeof e.data.height === 'number') {
        iframeRef.current!.style.height = `${Math.min(e.data.height, 2000)}px`;
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [oversized]);

  if (oversized) {
    return (
      <div className="text-red-500 text-sm p-2" role="alert">
        Sandbox content exceeds 200KB limit.
      </div>
    );
  }

  const handleOpenInTab = () => {
    const win = window.open('', '_blank');
    if (win) {
      win.document.write(srcdoc);
      win.document.close();
    }
  };

  return (
    <div className="collab-sandbox-block my-3 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        <span className="text-xs text-gray-500 dark:text-gray-400">Sandbox</span>
        <button
          onClick={handleOpenInTab}
          className="text-xs text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
        >
          Open in new tab
        </button>
      </div>
      <iframe
        ref={iframeRef}
        srcDoc={srcdoc}
        sandbox="allow-scripts"
        className="w-full border-0"
        style={{ height: '400px' }}
        title="Agent sandbox content"
      />
    </div>
  );
}
