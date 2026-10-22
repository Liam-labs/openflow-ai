'use client';

import { useState } from 'react';
import { KeyRound, Eye, EyeOff, Zap, Loader2, CheckCircle, AlertTriangle } from 'lucide-react';
import type { SetupData } from '@/components/SetupWizard';
import { SubscriptionSignIn } from '@/components/setup/SubscriptionSignIn';

interface StepCredentialsProps {
  data: SetupData['credentials'];
  onChange: (data: SetupData['credentials']) => void;
}

type TestState = 'idle' | 'loading' | 'success' | 'error';

function maskKey(value: string): string {
  if (value.length <= 4) return value;
  return '••••' + value.slice(-4);
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  placeholder,
  helpText,
  required,
  showTestButton,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  helpText?: string;
  required?: boolean;
  showTestButton?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  const [testState, setTestState] = useState<TestState>('idle');
  const [testError, setTestError] = useState<string>('');

  const handleTest = async () => {
    if (!value.trim()) return;
    setTestState('loading');
    setTestError('');
    try {
      const res = await fetch('/api/setup/test-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'anthropic', key: value }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.success !== false) {
        setTestState('success');
      } else {
        setTestState('error');
        setTestError(json.message || 'Connection failed. Check your key.');
      }
    } catch {
      setTestState('error');
      setTestError('Network error. Could not reach the server.');
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm text-white/60 font-medium">
        {label}
        {required && (
          <span className="text-red-400 ml-0.5" aria-hidden="true">
            *
          </span>
        )}
      </label>

      <div className="flex items-center gap-2">
        {/* Input wrapper — relative for absolute eye button */}
        <div className="relative flex-1 min-w-0">
          <input
            id={id}
            type={visible ? 'text' : 'password'}
            className="glass-input pr-10"
            placeholder={placeholder}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            aria-required={required ? 'true' : undefined}
            autoComplete="off"
            spellCheck={false}
          />
          {/* Eye toggle */}
          <button
            type="button"
            onClick={() => setVisible((v) => !v)}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded text-white/30 hover:text-white/70 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#60a5fa]/50"
            aria-label={visible ? 'Hide key' : 'Show key'}
            tabIndex={-1}
          >
            {visible ? (
              <EyeOff className="w-4 h-4" />
            ) : (
              <Eye className="w-4 h-4" />
            )}
          </button>
        </div>

        {/* Test connection button — Anthropic only */}
        {showTestButton && (
          <button
            type="button"
            onClick={handleTest}
            disabled={!value.trim() || testState === 'loading'}
            className="glass-button flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium text-[#60a5fa] flex-shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ whiteSpace: 'nowrap' }}
          >
            {testState === 'loading' ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Zap className="w-3.5 h-3.5" />
            )}
            Test
          </button>
        )}
      </div>

      {/* Masked last-4 hint */}
      {value && !visible && (
        <p className="text-xs text-white/30 font-mono" aria-hidden="true">
          {maskKey(value)}
        </p>
      )}

      {/* Test result */}
      {showTestButton && testState === 'success' && (
        <div className="flex items-center gap-1.5">
          <CheckCircle className="w-3.5 h-3.5 text-green-400 flex-shrink-0" />
          <span className="text-xs text-green-400">Connection verified</span>
        </div>
      )}
      {showTestButton && testState === 'error' && (
        <div className="flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
          <span className="text-xs text-red-400">{testError}</span>
        </div>
      )}

      {/* Help text */}
      {helpText && (
        <p className="text-xs text-white/30 leading-relaxed">{helpText}</p>
      )}
    </div>
  );
}

export function StepCredentials({ data, onChange }: StepCredentialsProps) {
  const update = (field: keyof SetupData['credentials'], value: string) => {
    onChange({ ...data, [field]: value });
  };

  return (
    <div className="glass-card p-8">
      {/* Header */}
      <div className="flex items-center gap-4 mb-7">
        <div
          className="flex-shrink-0 p-3 rounded-xl"
          style={{
            background: 'rgba(59, 130, 246, 0.12)',
            border: '1px solid rgba(59, 130, 246, 0.25)',
            boxShadow: '0 0 16px rgba(59, 130, 246, 0.1)',
          }}
        >
          <KeyRound className="w-6 h-6 text-[#60a5fa]" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-white leading-tight">Connect your AI</h2>
          <p className="text-sm text-white/40 mt-0.5">Sign in with a subscription, or use an API key. Either one is enough.</p>
        </div>
      </div>

      {/* Subscription sign-in (Claude Code, Codex) */}
      <SubscriptionSignIn />

      <div className="flex items-center gap-3 my-6">
        <div className="flex-1 h-px" style={{ background: 'rgba(59, 130, 246, 0.15)' }} />
        <span className="text-xs text-white/30 tracking-wider uppercase flex-shrink-0">Or use an API key</span>
        <div className="flex-1 h-px" style={{ background: 'rgba(59, 130, 246, 0.15)' }} />
      </div>

      {/* Optional — Anthropic key */}
      <div className="flex flex-col gap-5">
        <PasswordField
          id="cred-anthropic"
          label="Anthropic API Key"
          value={data.anthropicKey}
          onChange={(v) => update('anthropicKey', v)}
          placeholder="sk-ant-..."
          helpText="Optional. Billed per use by Anthropic. If you set a key, Claude Code uses it instead of your subscription, so leave it empty to use the subscription. Get one at console.anthropic.com"
          showTestButton
        />
      </div>

      {/* Divider */}
      <div className="flex items-center gap-3 my-6">
        <div
          className="flex-1 h-px"
          style={{ background: 'rgba(59, 130, 246, 0.15)' }}
        />
        <span className="text-xs text-white/30 tracking-wider uppercase flex-shrink-0">
          Optional Providers
        </span>
        <div
          className="flex-1 h-px"
          style={{ background: 'rgba(59, 130, 246, 0.15)' }}
        />
      </div>

      {/* Optional fields */}
      <div className="flex flex-col gap-5">
        <PasswordField
          id="cred-openrouter"
          label="OpenRouter API Key"
          value={data.openrouterKey}
          onChange={(v) => update('openrouterKey', v)}
          helpText="Optional. Enables additional model routing."
        />

        <PasswordField
          id="cred-grok"
          label="Grok API Key"
          value={data.grokKey}
          onChange={(v) => update('grokKey', v)}
          helpText="Optional. XAI Grok models."
        />

        {/* Ollama URL — plain text, no password toggle */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="cred-ollama" className="text-sm text-white/60 font-medium">
            Ollama URL
          </label>
          <input
            id="cred-ollama"
            type="url"
            className="glass-input"
            placeholder="http://localhost:11434"
            value={data.ollamaUrl}
            onChange={(e) => update('ollamaUrl', e.target.value)}
            autoComplete="url"
            spellCheck={false}
          />
          <p className="text-xs text-white/30 leading-relaxed">
            Optional. Local Ollama instance, e.g. http://localhost:11434
          </p>
        </div>
      </div>
    </div>
  );
}
