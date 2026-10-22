'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import './MermaidBlock.css';

export interface MermaidBlockProps {
  source: string;
}

let mermaidInitialized = false;

async function getMermaid() {
  const mod = await import('mermaid');
  const mermaid = mod.default;
  if (!mermaidInitialized) {
    mermaid.initialize({
      startOnLoad: false,
      theme: 'dark',
      themeVariables: {
        primaryColor: '#1e3a5f',
        primaryTextColor: '#e4e4e7',
        primaryBorderColor: '#3b82f6',
        lineColor: '#4b5563',
        secondaryColor: '#0a1428',
        tertiaryColor: '#0f2040',
        background: '#080e1c',
        mainBkg: '#0a1428',
        nodeBorder: '#3b82f6',
        clusterBkg: '#0f2040',
        titleColor: '#a1a1aa',
        edgeLabelBackground: '#0a1428',
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        fontSize: '12px',
      },
    });
    mermaidInitialized = true;
  }
  return mermaid;
}

export default function MermaidBlock({ source }: MermaidBlockProps) {
  const uid = useId().replace(/:/g, '-');
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const renderCount = useRef(0);

  useEffect(() => {
    const trimmed = source.trim();
    if (!trimmed) {
      setError('Empty diagram source.');
      return;
    }

    const count = ++renderCount.current;
    setSvg(null);
    setError(null);

    getMermaid()
      .then(mermaid => mermaid.render(`cb-mmd-${uid}-${count}`, trimmed))
      .then(({ svg: rendered }) => {
        if (renderCount.current === count) setSvg(rendered);
      })
      .catch((err: unknown) => {
        if (renderCount.current === count) {
          const raw = err instanceof Error ? err.message : String(err);
          // Strip any HTML tags mermaid may embed in error messages
          setError(raw.replace(/<[^>]*>/g, '').trim() || 'Could not parse diagram.');
        }
      });
  }, [source, uid]);

  if (error) {
    return (
      <div className="cb-mermaid cb-mermaid--error" role="alert">
        Diagram parse error: {error}
      </div>
    );
  }

  if (!svg) {
    return (
      <div
        className="cb-mermaid cb-mermaid--loading"
        aria-busy="true"
        aria-label="Rendering diagram"
      />
    );
  }

  return (
    <div
      className="cb-mermaid"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: svg }}
      aria-label="Mermaid diagram"
    />
  );
}
