'use client';

import { useState } from 'react';
import { getDevflowHome } from '@/lib/home-dir';
import {
  CheckCircle,
  ChevronRight,
  ExternalLink,
  Copy,
  Check,
  Loader2,
  AlertTriangle,
} from 'lucide-react';
import { PRODUCT_NAME } from '@/lib/brand';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SlackSetupWizardProps {
  onComplete: () => void;
  onCancel: () => void;
}

type Step = 1 | 2 | 3 | 4;

// ─── Step Indicator ───────────────────────────────────────────────────────────

function StepIndicator({ current }: { current: Step }) {
  const steps: { n: Step; label: string }[] = [
    { n: 1, label: 'Create App' },
    { n: 2, label: 'Scopes' },
    { n: 3, label: 'Tokens' },
    { n: 4, label: 'Done' },
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
                  ? 'bg-violet-500/30 border-violet-500/60 text-violet-400'
                  : s.n === current
                  ? 'bg-violet-500/40 border-violet-500 text-white shadow-[0_0_12px_rgba(139,92,246,0.4)]'
                  : 'bg-white/5 border-white/10 text-white/30',
              ].join(' ')}
            >
              {s.n < current ? <CheckCircle className="w-3.5 h-3.5" /> : s.n}
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
                s.n < current ? 'bg-violet-500/40' : 'bg-white/10',
              ].join(' ')}
            />
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Copy Block ───────────────────────────────────────────────────────────────

function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text).catch(() => {/* non-fatal */});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative rounded-xl overflow-hidden border border-violet-500/20 bg-violet-500/5">
      <pre className="px-4 py-3 text-xs text-violet-200 font-mono leading-relaxed whitespace-pre-wrap pr-12">
        {text}
      </pre>
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 p-1.5 rounded-lg transition-all
          bg-violet-500/20 hover:bg-violet-500/35 text-violet-300"
        title="Copy to clipboard"
      >
        {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
}

// ─── Step 1: Create App ───────────────────────────────────────────────────────

function Step1CreateApp({ onNext, onCancel }: { onNext: () => void; onCancel: () => void }) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2.5 rounded-xl bg-violet-500/10 border border-violet-500/20">
          <svg className="w-6 h-6 text-violet-400" viewBox="0 0 24 24" fill="currentColor">
            <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"/>
          </svg>
        </div>
        <div>
          <h2 className="text-xl font-semibold text-white">Create a Slack App</h2>
          <p className="text-xs text-white/40 mt-0.5">api.slack.com/apps</p>
        </div>
      </div>

      <p className="text-sm text-white/60 leading-relaxed mb-5">
        You&apos;ll need a Slack app to connect {PRODUCT_NAME} to your workspace. Create one now at the Slack API portal.
      </p>

      <div className="space-y-2.5 mb-5">
        {[
          'Go to api.slack.com/apps → "Create New App"',
          'Choose "From scratch"',
          `App name: ${PRODUCT_NAME} Bridge (or any name)`,
          'Select your workspace',
        ].map((step, i) => (
          <div key={i} className="flex items-start gap-3 px-3.5 py-2.5 rounded-xl bg-white/[0.03] border border-white/[0.06]">
            <span className="text-xs font-bold text-violet-400 mt-0.5 flex-shrink-0">{i + 1}.</span>
            <span className="text-sm text-white/70">{step}</span>
          </div>
        ))}
      </div>

      <a
        href="https://api.slack.com/apps"
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl mb-3
          border border-violet-500/30 text-violet-300 hover:bg-violet-500/10 transition-all text-sm"
      >
        <ExternalLink className="w-4 h-4" />
        Open Slack API Portal
      </a>

      <button
        onClick={() => fetch('/api/folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: `${getDevflowHome()}/.DevData/docs/DevFlow/setup-guides/setup-guide-slack.md` }) })}
        className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl mb-6
          text-white/40 hover:text-white/60 transition-all text-sm"
      >
        <ExternalLink className="w-3.5 h-3.5" />
        Full Setup Guide
      </button>

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
          Continue
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

// ─── Step 2: Scopes ───────────────────────────────────────────────────────────

const SLACK_SCOPES = `channels:history, channels:read, chat:write, groups:history, groups:read, im:history, im:read, im:write, users:read`;

function Step2Scopes({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  return (
    <div className="flex flex-col">
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-white mb-1">Add OAuth Scopes</h2>
        <p className="text-xs text-white/40">Grant the required permissions to your bot</p>
      </div>

      <p className="text-sm text-white/60 leading-relaxed mb-4">
        In your Slack app settings: <span className="text-white/80 font-medium">OAuth &amp; Permissions → Bot Token Scopes</span>. Add each of these scopes:
      </p>

      <div className="mb-5">
        <CopyBlock text={SLACK_SCOPES} />
      </div>

      <div className="space-y-2.5 mb-6">
        {[
          { icon: '✓', color: 'text-violet-400', text: 'channels:history / groups:history / im:history — Read messages' },
          { icon: '✓', color: 'text-violet-400', text: 'channels:read / groups:read / im:read — List channels' },
          { icon: '✓', color: 'text-violet-400', text: 'chat:write — Send messages as bot' },
          { icon: '✓', color: 'text-violet-400', text: 'im:write / users:read — DMs and user info' },
        ].map((item, i) => (
          <div key={i} className="flex items-start gap-3 px-3.5 py-2 rounded-xl bg-white/[0.03] border border-white/[0.06]">
            <span className={`text-sm font-bold mt-0.5 flex-shrink-0 ${item.color}`}>{item.icon}</span>
            <span className="text-xs text-white/60 font-mono">{item.text}</span>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <button onClick={onBack} className="glass-button px-4 py-2.5 text-sm text-white/60 hover:text-white/80">
          Back
        </button>
        <button
          onClick={onNext}
          className="glass-button primary flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white"
        >
          Continue
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

// ─── Step 3: Tokens ───────────────────────────────────────────────────────────

function Step3Tokens({
  onBack,
  onSuccess,
}: {
  onBack: () => void;
  onSuccess: (workspaceName: string) => void;
}) {
  const [botToken, setBotToken] = useState('');
  const [signingSecret, setSigningSecret] = useState('');
  const [appToken, setAppToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async () => {
    if (!botToken.trim() || !signingSecret.trim()) {
      setError('Bot Token and Signing Secret are required');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/bridges/slack/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          botToken: botToken.trim(),
          signingSecret: signingSecret.trim(),
          appToken: appToken.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `Failed (${res.status})`);
      }
      const data = await res.json() as { workspaceName?: string };
      onSuccess(data.workspaceName ?? 'Slack');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Configuration failed');
    } finally {
      setSaving(false);
    }
  };

  const inputStyle = {
    background: 'rgba(10,20,40,0.5)',
    border: '1px solid rgba(139,92,246,0.2)',
    outline: 'none',
  };

  return (
    <div className="flex flex-col">
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-white mb-1">Enter Credentials</h2>
        <p className="text-xs text-white/40">Found in your Slack app settings</p>
      </div>

      <div className="space-y-4 mb-5">
        <div>
          <label className="block text-sm font-medium text-white/80 mb-1.5">
            Bot Token <span className="text-violet-400">*</span>
          </label>
          <input
            type="password"
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            placeholder="xoxb-..."
            className="glass-input w-full px-3.5 py-2.5 rounded-xl text-sm font-mono text-white/80 placeholder:text-white/20"
            style={inputStyle}
          />
          <p className="text-xs text-white/35 mt-1.5">OAuth &amp; Permissions → Bot User OAuth Token</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-white/80 mb-1.5">
            Signing Secret <span className="text-violet-400">*</span>
          </label>
          <input
            type="password"
            value={signingSecret}
            onChange={(e) => setSigningSecret(e.target.value)}
            placeholder="xxxxxxxxxxxxxxxxxxxxxxxx"
            className="glass-input w-full px-3.5 py-2.5 rounded-xl text-sm font-mono text-white/80 placeholder:text-white/20"
            style={inputStyle}
          />
          <p className="text-xs text-white/35 mt-1.5">Basic Information → App Credentials → Signing Secret</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-white/80 mb-1.5">
            App Token <span className="text-white/30">(optional — for Socket Mode)</span>
          </label>
          <input
            type="password"
            value={appToken}
            onChange={(e) => setAppToken(e.target.value)}
            placeholder="xapp-..."
            className="glass-input w-full px-3.5 py-2.5 rounded-xl text-sm font-mono text-white/80 placeholder:text-white/20"
            style={inputStyle}
          />
          <p className="text-xs text-white/35 mt-1.5">Basic Information → App-Level Tokens. Needed only for Socket Mode.</p>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2.5 px-3.5 py-3 rounded-xl bg-red-500/10 border border-red-500/20 mb-4">
          <AlertTriangle className="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0" />
          <p className="text-xs text-red-300">{error}</p>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button onClick={onBack} disabled={saving} className="glass-button px-4 py-2.5 text-sm text-white/60 hover:text-white/80 disabled:opacity-40">
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
              Validating...
            </>
          ) : (
            <>
              Save &amp; Validate
              <ChevronRight className="w-4 h-4" />
            </>
          )}
        </button>
      </div>
    </div>
  );
}

// ─── Step 4: Done ─────────────────────────────────────────────────────────────

function Step4Done({ workspaceName, onComplete }: { workspaceName: string; onComplete: () => void }) {
  return (
    <div className="flex flex-col items-center text-center">
      <div className="relative mb-6">
        <div className="absolute inset-0 rounded-full bg-violet-500/20 blur-xl animate-pulse" />
        <div className="relative p-5 rounded-full bg-violet-500/15 border-2 border-violet-500/40">
          <CheckCircle className="w-12 h-12 text-violet-400" />
        </div>
      </div>

      <h2 className="text-2xl font-semibold text-white mb-2">Slack is connected!</h2>
      <p className="text-base text-white/60 mb-4">{workspaceName}</p>

      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-green-500/20 text-green-300 border border-green-500/30 text-sm font-medium mb-5">
        <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
        Active
      </span>

      <p className="text-sm text-white/55 max-w-xs leading-relaxed mb-8">
        Your Slack workspace is now bridged to {PRODUCT_NAME}. Set up channel mappings to route messages to your collab channels.
      </p>

      <button
        onClick={onComplete}
        className="glass-button primary px-8 py-3 text-sm font-medium text-white w-full max-w-xs"
      >
        Open Slack Panel
      </button>
    </div>
  );
}

// ─── Main Wizard ──────────────────────────────────────────────────────────────

export function SlackSetupWizard({ onComplete, onCancel }: SlackSetupWizardProps) {
  const [step, setStep] = useState<Step>(1);
  const [workspaceName, setWorkspaceName] = useState('Slack');

  const handleSuccess = (name: string) => {
    setWorkspaceName(name);
    setStep(4);
  };

  return (
    <div className="flex flex-col w-full max-w-[600px] mx-auto">
      <StepIndicator current={step} />
      <div
        className="glass-card p-8"
        style={{ background: 'rgba(8,14,28,0.97)', backdropFilter: 'none', WebkitBackdropFilter: 'none' }}
      >
        {step === 1 && <Step1CreateApp onNext={() => setStep(2)} onCancel={onCancel} />}
        {step === 2 && <Step2Scopes onBack={() => setStep(1)} onNext={() => setStep(3)} />}
        {step === 3 && <Step3Tokens onBack={() => setStep(2)} onSuccess={handleSuccess} />}
        {step === 4 && <Step4Done workspaceName={workspaceName} onComplete={onComplete} />}
      </div>
    </div>
  );
}
