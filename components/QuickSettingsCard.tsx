'use client';

import { useState, useRef, useEffect } from 'react';
import { Settings, X, Monitor, Bell, Bot, RotateCcw, Check } from 'lucide-react';

interface SettingsState {
  compactDensity: boolean;
  showAgentAvatars: boolean;
  autoScrollLogs: boolean;
  criticalAlertsOnly: boolean;
  soundOnAlert: boolean;
  badgeCount: boolean;
  autoClaimTasks: boolean;
  verboseLogs: boolean;
  pauseOnError: boolean;
}

const DEFAULTS: SettingsState = {
  compactDensity: false,
  showAgentAvatars: true,
  autoScrollLogs: true,
  criticalAlertsOnly: false,
  soundOnAlert: false,
  badgeCount: true,
  autoClaimTasks: true,
  verboseLogs: false,
  pauseOnError: true,
};

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={`qsc-toggle ${on ? 'qsc-toggle--on' : ''}`}
    >
      <span className="qsc-toggle-thumb" />
    </button>
  );
}

function Row({ label, desc, value, onChange }: {
  label: string; desc?: string; value: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="qsc-row">
      <div className="qsc-row-label">
        <span className="qsc-row-name">{label}</span>
        {desc && <span className="qsc-row-desc">{desc}</span>}
      </div>
      <Toggle on={value} onChange={onChange} />
    </div>
  );
}

export default function QuickSettingsCard() {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<SettingsState>(DEFAULTS);
  const [saved, setSaved] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', handler); document.removeEventListener('keydown', esc); };
  }, [open]);

  const set = (key: keyof SettingsState) => (v: boolean) =>
    setSettings(s => ({ ...s, [key]: v }));

  const handleSave = () => {
    setSaved(true);
    setTimeout(() => { setSaved(false); setOpen(false); }, 900);
  };

  return (
    <div className="qsc-anchor" ref={panelRef}>
      <button
        className={`qsc-trigger ${open ? 'qsc-trigger--active' : ''}`}
        onClick={() => setOpen(o => !o)}
        aria-label="Quick settings"
        aria-expanded={open}
      >
        <Settings size={15} />
      </button>

      {open && (
        <div className="qsc-panel" role="dialog" aria-label="Quick settings">
          <header className="qsc-header">
            <span className="qsc-header-title">Quick Settings</span>
            <button className="qsc-close" onClick={() => setOpen(false)} aria-label="Close"><X size={13} /></button>
          </header>

          <div className="qsc-body">
            <section className="qsc-section">
              <div className="qsc-section-title"><Monitor size={11} />Display</div>
              <Row label="Compact density" desc="Tighter rows and padding" value={settings.compactDensity} onChange={set('compactDensity')} />
              <Row label="Agent avatars" desc="Show icons in agent lists" value={settings.showAgentAvatars} onChange={set('showAgentAvatars')} />
              <Row label="Auto-scroll logs" value={settings.autoScrollLogs} onChange={set('autoScrollLogs')} />
            </section>

            <section className="qsc-section">
              <div className="qsc-section-title"><Bell size={11} />Notifications</div>
              <Row label="Critical only" desc="Suppress info/warning alerts" value={settings.criticalAlertsOnly} onChange={set('criticalAlertsOnly')} />
              <Row label="Sound on alert" value={settings.soundOnAlert} onChange={set('soundOnAlert')} />
              <Row label="Badge count" value={settings.badgeCount} onChange={set('badgeCount')} />
            </section>

            <section className="qsc-section">
              <div className="qsc-section-title"><Bot size={11} />Agents</div>
              <Row label="Auto-claim tasks" desc="Agents claim on assignment" value={settings.autoClaimTasks} onChange={set('autoClaimTasks')} />
              <Row label="Verbose logs" value={settings.verboseLogs} onChange={set('verboseLogs')} />
              <Row label="Pause on error" desc="Halt agent on unhandled error" value={settings.pauseOnError} onChange={set('pauseOnError')} />
            </section>
          </div>

          <footer className="qsc-footer">
            <button className="qsc-btn qsc-btn--ghost" onClick={() => setSettings(DEFAULTS)}>
              <RotateCcw size={11} />Reset
            </button>
            <button className={`qsc-btn qsc-btn--primary ${saved ? 'qsc-btn--saved' : ''}`} onClick={handleSave}>
              {saved ? <><Check size={11} />Saved</> : 'Save'}
            </button>
          </footer>
        </div>
      )}
    </div>
  );
}
