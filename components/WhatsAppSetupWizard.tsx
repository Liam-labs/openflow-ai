'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import QRCode from 'qrcode';
import { HUMAN_ROUTING_NAME } from '@/lib/human-identity';
import {
  CheckCircle,
  ChevronRight,
  QrCode,
  Link,
  Phone,
  Loader2,
  AlertTriangle,
  Wifi,
  X,
} from 'lucide-react';
import { PRODUCT_NAME } from '@/lib/brand';

// ─── Types ───────────────────────────────────────────────────────────────────

interface WhatsAppSetupWizardProps {
  onComplete: () => void;
  onCancel: () => void;
  initialStep?: Step;
  initialTab?: PairTab;
}

type Step = 1 | 2 | 3 | 4;
type PairTab = 'qr' | 'code';

interface ConfigForm {
  allowedNumbers: string;
  commanderName: string;
  channelName: string;
}

interface QREvent {
  qr: string;
}

interface ConnectedEvent {
  phone?: string;
  name?: string;
}

// ─── Step Indicator ──────────────────────────────────────────────────────────

function StepIndicator({ current }: { current: Step }) {
  const steps = [
    { n: 1 as Step, label: 'Intro' },
    { n: 2 as Step, label: 'Configure' },
    { n: 3 as Step, label: 'Pair' },
    { n: 4 as Step, label: 'Done' },
  ];

  return (
    <div className="flex items-center justify-center gap-0 mb-8">
      {steps.map((s, i) => (
        <div key={s.n} className="flex items-center">
          <div className="flex flex-col items-center gap-1.5">
            <div
              className={[
                'w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold border transition-all duration-300',
                s.n < current
                  ? 'bg-[#3b82f6]/30 border-[#3b82f6]/60 text-[#60a5fa]'
                  : s.n === current
                  ? 'bg-[#3b82f6]/40 border-[#3b82f6] text-white shadow-[0_0_12px_rgba(59,130,246,0.4)]'
                  : 'bg-white/5 border-white/10 text-white/30',
              ].join(' ')}
            >
              {s.n < current ? (
                <CheckCircle className="w-3.5 h-3.5" />
              ) : (
                s.n
              )}
            </div>
            <span
              className={[
                'text-[10px] font-medium tracking-wide hidden sm:block',
                s.n === current ? 'text-white/80' : 'text-white/30',
              ].join(' ')}
            >
              {s.label}
            </span>
          </div>
          {i < steps.length - 1 && (
            <div
              className={[
                'w-12 h-px mb-5 mx-1 transition-all duration-300',
                s.n < current ? 'bg-[#3b82f6]/40' : 'bg-white/10',
              ].join(' ')}
            />
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Step 1: Intro ───────────────────────────────────────────────────────────

function Step1Intro({ onNext, onCancel }: { onNext: () => void; onCancel: () => void }) {
  return (
    <div className="flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2.5 rounded-xl bg-green-500/10 border border-green-500/20">
          {/* WhatsApp-esque icon */}
          <svg className="w-6 h-6 text-green-400" viewBox="0 0 24 24" fill="currentColor">
            <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
          </svg>
        </div>
        <div>
          <h2 className="text-xl font-semibold text-white">Connect WhatsApp</h2>
          <p className="text-xs text-white/40 mt-0.5">Personal device bridge</p>
        </div>
      </div>

      {/* Description */}
      <p className="text-sm text-white/60 leading-relaxed mb-5">
        No Meta account or business registration required. {PRODUCT_NAME} links to your existing WhatsApp
        as a connected device — the same way WhatsApp Web works.
      </p>

      {/* Feature bullets */}
      <div className="space-y-2.5 mb-8">
        {[
          { icon: '✓', color: 'text-green-400', text: 'Works with any personal WhatsApp number' },
          { icon: '✓', color: 'text-green-400', text: 'No API keys or webhooks needed' },
          { icon: '✓', color: 'text-green-400', text: 'Scan a QR code to link your phone' },
          { icon: '⚠', color: 'text-amber-400', text: 'Your phone must be connected to the internet' },
        ].map((item, i) => (
          <div
            key={i}
            className="flex items-start gap-3 px-3.5 py-2.5 rounded-xl bg-white/[0.03] border border-white/[0.06]"
          >
            <span className={`text-sm font-bold mt-0.5 ${item.color}`}>{item.icon}</span>
            <span className="text-sm text-white/70">{item.text}</span>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3">
        <button
          onClick={onCancel}
          className="glass-button px-4 py-2.5 text-sm text-white/60 hover:text-white/80"
        >
          Cancel
        </button>
        <button
          onClick={onNext}
          className="glass-button primary flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white"
        >
          Get Started
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

// ─── Step 2: Configure ───────────────────────────────────────────────────────

function Step2Configure({
  onBack,
  onNext,
}: {
  onBack: () => void;
  onNext: () => void;
}) {
  const [form, setForm] = useState<ConfigForm>({
    allowedNumbers: '',
    commanderName: 'Jack',
    channelName: `WhatsApp — ${HUMAN_ROUTING_NAME}`,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async () => {
    const numbers = form.allowedNumbers
      .split('\n')
      .map((n) => n.trim())
      .filter(Boolean);

    setSaving(true);
    setError('');

    try {
      const res = await fetch('/api/bridges/whatsapp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'configure',
          allowedNumbers: numbers,
          commanderName: form.commanderName.trim() || 'Jack',
          channelName: form.channelName.trim() || `WhatsApp — ${HUMAN_ROUTING_NAME}`,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `Failed (${res.status})`);
      }

      onNext();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col">
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-white mb-1">Configuration</h2>
        <p className="text-xs text-white/40">Set your allowed numbers and agent details</p>
      </div>

      <div className="space-y-5 mb-6">
        {/* Allowed Numbers */}
        <div>
          <label className="block text-sm font-medium text-white/80 mb-1.5">
            Allowed Numbers
          </label>
          <textarea
            value={form.allowedNumbers}
            onChange={(e) => setForm((f) => ({ ...f, allowedNumbers: e.target.value }))}
            rows={4}
            placeholder={'+447534893277\n+447700900001'}
            className="glass-input w-full px-3.5 py-2.5 rounded-xl text-sm font-mono text-white/80 placeholder:text-white/20 resize-none"
            style={{
              background: 'rgba(10, 20, 40, 0.5)',
              border: '1px solid rgba(59, 130, 246, 0.2)',
              outline: 'none',
            }}
          />
          <p className="text-xs text-white/35 mt-1.5 leading-relaxed">
            Only messages from these numbers will be processed. One per line, E.164 format.
          </p>
        </div>

        {/* Commander Name */}
        <div>
          <label className="block text-sm font-medium text-white/80 mb-1.5">
            Commander Name
          </label>
          <input
            type="text"
            value={form.commanderName}
            onChange={(e) => setForm((f) => ({ ...f, commanderName: e.target.value }))}
            className="glass-input w-full px-3.5 py-2.5 rounded-xl text-sm text-white/80"
            style={{
              background: 'rgba(10, 20, 40, 0.5)',
              border: '1px solid rgba(59, 130, 246, 0.2)',
              outline: 'none',
            }}
          />
          <p className="text-xs text-white/35 mt-1.5">
            The agent name that will respond to WhatsApp messages.
          </p>
        </div>

        {/* Channel Name */}
        <div>
          <label className="block text-sm font-medium text-white/80 mb-1.5">
            Channel Name
          </label>
          <input
            type="text"
            value={form.channelName}
            onChange={(e) => setForm((f) => ({ ...f, channelName: e.target.value }))}
            className="glass-input w-full px-3.5 py-2.5 rounded-xl text-sm text-white/80"
            style={{
              background: 'rgba(10, 20, 40, 0.5)',
              border: '1px solid rgba(59, 130, 246, 0.2)',
              outline: 'none',
            }}
          />
          <p className="text-xs text-white/35 mt-1.5">{PRODUCT_NAME} collab channel name.</p>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-start gap-2.5 px-3.5 py-3 rounded-xl bg-red-500/10 border border-red-500/20 mb-4">
          <AlertTriangle className="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0" />
          <p className="text-xs text-red-300">{error}</p>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          disabled={saving}
          className="glass-button px-4 py-2.5 text-sm text-white/60 hover:text-white/80 disabled:opacity-40"
        >
          Back
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="glass-button primary flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-60"
        >
          {saving ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Saving...
            </>
          ) : (
            <>
              Save & Continue
              <ChevronRight className="w-4 h-4" />
            </>
          )}
        </button>
      </div>
    </div>
  );
}

// ─── QR Countdown Ring ───────────────────────────────────────────────────────

function CountdownRing({ seconds, total }: { seconds: number; total: number }) {
  const radius = 18;
  const circumference = 2 * Math.PI * radius;
  const progress = seconds / total;
  const strokeDashoffset = circumference * (1 - progress);

  return (
    <div className="flex items-center gap-2">
      <svg width="44" height="44" className="-rotate-90">
        <circle
          cx="22"
          cy="22"
          r={radius}
          fill="none"
          stroke="rgba(255,255,255,0.08)"
          strokeWidth="3"
        />
        <circle
          cx="22"
          cy="22"
          r={radius}
          fill="none"
          stroke={seconds <= 8 ? '#ef4444' : '#3b82f6'}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          style={{ transition: 'stroke-dashoffset 1s linear, stroke 0.3s ease' }}
        />
      </svg>
      <span
        className={`text-sm font-mono font-semibold tabular-nums ${
          seconds <= 8 ? 'text-red-400' : 'text-white/50'
        }`}
      >
        {String(seconds).padStart(2, '0')}s
      </span>
    </div>
  );
}

// ─── Step 3: Pair ────────────────────────────────────────────────────────────

function Step3Pair({
  onBack,
  onConnected,
  initialTab = 'qr',
}: {
  onBack: () => void;
  onConnected: (phone?: string, name?: string) => void;
  initialTab?: PairTab;
}) {
  const [tab, setTab] = useState<PairTab>(initialTab);

  // QR tab state
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrCountdown, setQrCountdown] = useState(30);
  const [qrError, setQrError] = useState('');
  const [sseReady, setSseReady] = useState(false);
  const [timedOut, setTimedOut] = useState(false);

  // Pairing code tab state
  const [phoneInput, setPhoneInput] = useState('');
  const [pairCode, setPairCode] = useState('');
  const [pairLoading, setPairLoading] = useState(false);
  const [pairError, setPairError] = useState('');

  const esRef = useRef<EventSource | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetCountdown = useCallback(() => {
    setQrCountdown(30);
    if (countdownRef.current) clearInterval(countdownRef.current);
    countdownRef.current = setInterval(() => {
      setQrCountdown((c) => {
        if (c <= 1) {
          if (countdownRef.current) clearInterval(countdownRef.current);
          return 0;
        }
        return c - 1;
      });
    }, 1000);
  }, []);

  const openSSE = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    setQrDataUrl(null);
    setQrError('');
    setSseReady(false);
    setTimedOut(false);

    const es = new EventSource('/api/bridges/whatsapp/qr');
    esRef.current = es;

    es.addEventListener('open', () => setSseReady(true));

    es.addEventListener('qr', async (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as QREvent;
        const url = await QRCode.toDataURL(data.qr, { width: 256, margin: 2 });
        setQrDataUrl(url);
        setQrError('');
        resetCountdown();
      } catch {
        setQrError('Failed to render QR code');
      }
    });

    es.addEventListener('connected', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as ConnectedEvent;
        es.close();
        onConnected(data.phone, data.name);
      } catch {
        onConnected();
      }
    });

    es.addEventListener('error', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { code?: string };
        if (data.code === 'QR_EXPIRED') {
          setQrError('QR expired — generating new one…');
          setQrDataUrl(null);
          return;
        }
      } catch {
        // parse error — ignore
      }
      setQrError('Connection error. Check that the bridge is running.');
    });

    // 3-minute timeout
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      es.close();
      setTimedOut(true);
    }, 3 * 60 * 1000);
  }, [onConnected, resetCountdown]);

  // Open SSE on mount and on tab switch to QR
  useEffect(() => {
    if (tab === 'qr') {
      openSSE();
    } else {
      // Close SSE when on code tab (still want connected events though)
      // Actually keep it open so we can auto-advance
    }

    return () => {
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
      if (countdownRef.current) clearInterval(countdownRef.current);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const handleGetCode = async () => {
    if (!phoneInput.trim()) return;
    setPairLoading(true);
    setPairError('');
    setPairCode('');

    try {
      const res = await fetch('/api/bridges/whatsapp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'pair', phoneNumber: phoneInput.trim() }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `Failed (${res.status})`);
      }

      const data = (await res.json()) as { code: string };
      setPairCode(data.code);

      // Also open SSE to listen for connected
      openSSE();
    } catch (err) {
      setPairError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setPairLoading(false);
    }
  };

  return (
    <div className="flex flex-col">
      <div className="mb-5">
        <h2 className="text-xl font-semibold text-white mb-1">Link Your Phone</h2>
        <p className="text-xs text-white/40">Choose a pairing method below</p>
      </div>

      {/* Tab switcher */}
      <div className="tab-nav mb-5">
        <button
          onClick={() => setTab('qr')}
          className={`tab-item flex items-center gap-2 flex-1 justify-center ${tab === 'qr' ? 'active' : ''}`}
        >
          <QrCode className="w-3.5 h-3.5" />
          QR Code
        </button>
        <button
          onClick={() => setTab('code')}
          className={`tab-item flex items-center gap-2 flex-1 justify-center ${tab === 'code' ? 'active' : ''}`}
        >
          <Link className="w-3.5 h-3.5" />
          Pairing Code
        </button>
      </div>

      {/* QR Tab */}
      {tab === 'qr' && (
        <div className="flex flex-col items-center min-h-[280px]">
          {timedOut ? (
            <div className="flex flex-col items-center gap-4 py-8">
              <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20">
                <AlertTriangle className="w-6 h-6 text-amber-400" />
              </div>
              <p className="text-sm text-white/60 text-center max-w-xs">
                Taking too long?
              </p>
              <button
                onClick={() => setTab('code')}
                className="text-sm text-[#60a5fa] hover:text-white underline underline-offset-2 transition-colors"
              >
                Try the pairing code instead →
              </button>
              <button
                onClick={openSSE}
                className="glass-button px-4 py-2 text-sm text-white/60"
              >
                Retry QR
              </button>
            </div>
          ) : !sseReady || (!qrDataUrl && !qrError) ? (
            <div className="flex flex-col items-center gap-3 py-10">
              <Loader2 className="w-7 h-7 text-[#3b82f6] animate-spin" />
              <p className="text-sm text-white/40">Starting bridge...</p>
            </div>
          ) : qrError && !qrDataUrl ? (
            <div className="flex flex-col items-center gap-3 py-8">
              <p className="text-sm text-amber-400 text-center">{qrError}</p>
              <Loader2 className="w-5 h-5 text-white/30 animate-spin" />
            </div>
          ) : (
            <>
              {/* QR image */}
              {qrDataUrl && (
                <div className="relative mb-3">
                  <div
                    className="rounded-2xl overflow-hidden border-2 border-white/10 shadow-xl"
                    style={{ background: '#fff' }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={qrDataUrl}
                      alt="WhatsApp QR Code"
                      width={256}
                      height={256}
                      className="block"
                    />
                  </div>
                  {/* Error overlay */}
                  {qrError && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/60 rounded-2xl backdrop-blur-sm">
                      <p className="text-xs text-amber-400 text-center px-4">{qrError}</p>
                    </div>
                  )}
                </div>
              )}

              {/* Countdown */}
              <div className="flex items-center gap-3 mb-4">
                <CountdownRing seconds={qrCountdown} total={30} />
                <span className="text-xs text-white/35">QR refreshes automatically</span>
              </div>
            </>
          )}

          {/* Instruction */}
          <div className="w-full px-4 py-3 rounded-xl bg-white/[0.03] border border-white/[0.06] text-xs text-white/50 leading-relaxed text-center">
            Open WhatsApp → tap <span className="text-white/70 font-medium">⋮ Menu</span> (or{' '}
            <span className="text-white/70 font-medium">Settings</span> on iPhone) →{' '}
            <span className="text-white/70 font-medium">Linked Devices</span> →{' '}
            <span className="text-white/70 font-medium">Link a Device</span> → scan the code
          </div>
        </div>
      )}

      {/* Pairing Code Tab */}
      {tab === 'code' && (
        <div className="flex flex-col gap-4 min-h-[280px]">
          <div>
            <label className="block text-sm font-medium text-white/80 mb-1.5">
              Phone Number
            </label>
            <div className="flex gap-2">
              <div className="flex items-center gap-2 flex-1 px-3 py-2.5 rounded-xl"
                style={{
                  background: 'rgba(10, 20, 40, 0.5)',
                  border: '1px solid rgba(59, 130, 246, 0.2)',
                }}
              >
                <Phone className="w-4 h-4 text-white/30 flex-shrink-0" />
                <input
                  type="tel"
                  value={phoneInput}
                  onChange={(e) => setPhoneInput(e.target.value)}
                  placeholder="+447534893277"
                  className="flex-1 bg-transparent text-sm text-white/80 placeholder:text-white/25 outline-none font-mono"
                />
              </div>
              <button
                onClick={handleGetCode}
                disabled={pairLoading || !phoneInput.trim()}
                className="glass-button primary px-4 py-2.5 text-sm font-medium text-white whitespace-nowrap disabled:opacity-50 flex items-center gap-2"
              >
                {pairLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  'Get Code'
                )}
              </button>
            </div>
            <p className="text-xs text-white/35 mt-1.5">E.164 format, e.g. +447534893277</p>
          </div>

          {pairError && (
            <div className="flex items-start gap-2.5 px-3.5 py-3 rounded-xl bg-red-500/10 border border-red-500/20">
              <AlertTriangle className="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0" />
              <p className="text-xs text-red-300">{pairError}</p>
            </div>
          )}

          {pairCode && (
            <div className="flex flex-col items-center gap-3 py-4">
              <p className="text-xs text-white/40 uppercase tracking-widest">Your code</p>
              <div
                className="px-8 py-4 rounded-2xl text-center"
                style={{
                  background: 'rgba(59, 130, 246, 0.08)',
                  border: '1px solid rgba(59, 130, 246, 0.25)',
                }}
              >
                <span
                  className="text-4xl font-mono font-bold tracking-widest gradient-text"
                  style={{ letterSpacing: '0.2em' }}
                >
                  {pairCode}
                </span>
              </div>
              <p className="text-xs text-white/40 text-center leading-relaxed max-w-xs">
                In WhatsApp: <span className="text-white/60">Settings → Linked Devices → Link with phone number</span> → enter the code above
              </p>
              <div className="flex items-center gap-2 mt-1">
                <Loader2 className="w-3.5 h-3.5 text-[#3b82f6] animate-spin" />
                <span className="text-xs text-white/35">Waiting for confirmation...</span>
              </div>
            </div>
          )}

          {!pairCode && !pairError && (
            <div className="flex-1 flex items-center justify-center py-8">
              <p className="text-xs text-white/30 text-center max-w-xs leading-relaxed">
                Enter your phone number above to receive a pairing code. No QR scan required.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Back button */}
      <div className="mt-5 pt-4 border-t border-white/[0.06]">
        <button
          onClick={onBack}
          className="glass-button px-4 py-2.5 text-sm text-white/60 hover:text-white/80"
        >
          Back
        </button>
      </div>
    </div>
  );
}

// ─── Step 4: Confirmed ───────────────────────────────────────────────────────

function Step4Confirmed({
  phone,
  phoneName,
  onDone,
}: {
  phone?: string;
  phoneName?: string;
  onDone: () => void;
}) {
  return (
    <div className="flex flex-col items-center text-center">
      {/* Animated check */}
      <div className="relative mb-6">
        <div className="absolute inset-0 rounded-full bg-green-500/20 blur-xl animate-pulse" />
        <div className="relative p-5 rounded-full bg-green-500/15 border-2 border-green-500/40">
          <CheckCircle className="w-12 h-12 text-green-400" />
        </div>
      </div>

      <h2 className="text-2xl font-semibold text-white mb-2">Connected!</h2>

      {(phone || phoneName) && (
        <div className="flex items-center gap-2 mb-4">
          <Wifi className="w-4 h-4 text-green-400" />
          <span className="text-base text-white/80 font-medium">
            {[phone, phoneName].filter(Boolean).join(' · ')}
          </span>
        </div>
      )}

      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-green-500/20 text-green-300 border border-green-500/30 text-sm font-medium mb-5">
        <span className="status-dot online" />
        Active
      </span>

      <p className="text-sm text-white/55 max-w-xs leading-relaxed mb-8">
        WhatsApp messages from your allowed numbers will now route through {PRODUCT_NAME} to your Commander agent.
      </p>

      <button
        onClick={onDone}
        className="glass-button primary px-8 py-3 text-sm font-medium text-white w-full max-w-xs"
      >
        Done
      </button>
    </div>
  );
}

// ─── Main Wizard ─────────────────────────────────────────────────────────────

export function WhatsAppSetupWizard({ onComplete, onCancel, initialStep, initialTab }: WhatsAppSetupWizardProps) {
  const [step, setStep] = useState<Step>(initialStep ?? 1);
  const [pairedPhone, setPairedPhone] = useState<string | undefined>();
  const [pairedName, setPairedName] = useState<string | undefined>();

  const handleConnected = (phone?: string, name?: string) => {
    setPairedPhone(phone);
    setPairedName(name);
    setStep(4);
  };

  return (
    <div className="flex flex-col w-full max-w-[600px] mx-auto">
      {/* Step indicator */}
      <StepIndicator current={step} />

      {/* Step content */}
      <div className="glass-card p-8" style={{ background: 'rgba(8, 14, 28, 0.97)', backdropFilter: 'none', WebkitBackdropFilter: 'none' }}>
        {step === 1 && (
          <Step1Intro onNext={() => setStep(2)} onCancel={onCancel} />
        )}
        {step === 2 && (
          <Step2Configure onBack={() => setStep(1)} onNext={() => setStep(3)} />
        )}
        {step === 3 && (
          <Step3Pair onBack={() => setStep(2)} onConnected={handleConnected} initialTab={initialTab} />
        )}
        {step === 4 && (
          <Step4Confirmed
            phone={pairedPhone}
            phoneName={pairedName}
            onDone={onComplete}
          />
        )}
      </div>
    </div>
  );
}
