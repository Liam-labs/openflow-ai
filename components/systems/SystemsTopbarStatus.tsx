'use client';

import React, { useState, useEffect, useCallback } from 'react';

interface PM2Process {
  name: string;
  status: string;
  monit?: { cpu: number; memory: number };
}

export function SystemsTopbarStatus() {
  const [online, setOnline] = useState<number | null>(null);
  const [total, setTotal]   = useState<number | null>(null);
  const [cpu, setCpu]       = useState<number | null>(null);
  const [errored, setErrored] = useState(0);

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch('/api/pm2');
      if (!res.ok) return;
      const { processes = [] }: { processes: PM2Process[] } = await res.json();
      const services = processes.filter((p) => !p.name.startsWith('dev-'));
      setTotal(services.length);
      setOnline(services.filter((p) => p.status === 'online').length);
      setErrored(services.filter((p) => p.status === 'errored').length);
      const totalCpu = services.reduce((s, p) => s + (p.monit?.cpu ?? 0), 0);
      setCpu(Math.round(totalCpu * 10) / 10);
    } catch {
      // silent — topbar status is non-critical
    }
  }, []);

  useEffect(() => {
    fetch_();
    const id = setInterval(fetch_, 15_000);
    return () => clearInterval(id);
  }, [fetch_]);

  if (online === null || total === null) return null;

  const healthy = errored === 0 && online === total;

  return (
    <div className="stbs-wrap" aria-label="System health summary">
      <span className={`stbs-dot ${healthy ? 'stbs-dot--ok' : errored > 0 ? 'stbs-dot--err' : 'stbs-dot--warn'}`} />
      <span className="stbs-label">
        <span className={`stbs-value ${healthy ? 'stbs-value--ok' : errored > 0 ? 'stbs-value--err' : ''}`}>
          {online}
        </span>
        <span className="stbs-sep">/</span>
        <span className="stbs-value stbs-value--dim">{total}</span>
        <span className="stbs-unit">online</span>
      </span>
      {errored > 0 && (
        <span className="stbs-badge stbs-badge--err">{errored} errored</span>
      )}
      {cpu !== null && (
        <span className="stbs-cpu">CPU {cpu}%</span>
      )}
    </div>
  );
}
