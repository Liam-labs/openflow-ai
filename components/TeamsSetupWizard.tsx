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

interface TeamsSetupWizardProps {
  onComplete: () => void;
  onCancel: () => void;
}

type Step = 1 | 2 | 3 | 4 | 5;

// ─── Step Indicator ───────────────────────────────────────────────────────────

function StepIndicator({ current }: { current: Step }) {
  const steps: { n: Step; label: string }[] = [
    { n: 1, label: 'Azure App' },
    { n: 2, label: 'Credentials' },
    { n: 3, label: 'Bot' },
    { n: 4, label: 'Validate' },
    { n: 5, label: 'Done' },
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
                  ? 'bg-blue-500/30 border-blue-500/60 text-blue-400'
                  : s.n === current
                  ? 'bg-blue-500/40 border-blue-500 text-white shadow-[0_0_12px_rgba(59,130,246,0.4)]'
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
                'w-10 h-px mb-5 mx-1 transition-all duration-300',
                s.n < current ? 'bg-blue-500/40' : 'bg-white/10',
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
    <div className="relative rounded-xl overflow-hidden border border-blue-500/20 bg-blue-500/5">
      <pre className="px-4 py-3 text-xs text-blue-200 font-mono leading-relaxed whitespace-pre-wrap pr-12">
        {text}
      </pre>
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 p-1.5 rounded-lg transition-all
          bg-blue-500/20 hover:bg-blue-500/35 text-blue-300"
        title="Copy to clipboard"
      >
        {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
}

// ─── Step 1: Azure App ────────────────────────────────────────────────────────

function Step1AzureApp({ onNext, onCancel }: { onNext: () => void; onCancel: () => void }) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2.5 rounded-xl bg-blue-500/10 border border-blue-500/20">
          <svg className="w-6 h-6 text-blue-400" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19.404 4.5a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5ZM14.25 9h3.537a3.756 3.756 0 0 1-1.037-2.25h-2.5A3.754 3.754 0 0 1 10.5 3h-.25A3.754 3.754 0 0 1 6.5 6.75V9H1.75A1.752 1.752 0 0 0 0 10.75v6c0 .966.784 1.75 1.75 1.75H4v1.25A2.753 2.753 0 0 0 6.75 22.5h5.5a2.753 2.753 0 0 0 2.75-2.75v-1.25h-.75a1.752 1.752 0 0 1-1.75-1.75v-6A1.752 1.752 0 0 1 14.25 9z" />
          </svg>
        </div>
        <div>
          <h2 className="text-xl font-semibold text-white">Register Azure App</h2>
          <p className="text-xs text-white/40 mt-0.5">Azure Entra ID (portal.azure.com)</p>
        </div>
      </div>

      <p className="text-sm text-white/60 leading-relaxed mb-5">
        Register a new application in Azure Entra ID. This gives {PRODUCT_NAME} permission to access your Teams workspace.
      </p>

      <div className="space-y-2.5 mb-5">
        {[
          'Go to portal.azure.com → Azure Active Directory / Entra ID',
          'App registrations → New registration',
          `Name: ${PRODUCT_NAME} Bridge (any name)`,
          'Supported account types: Any Azure AD directory (multitenant)',
          'Redirect URI: leave blank for now',
          'Click Register — note the Application (client) ID and Tenant ID',
        ].map((step, i) => (
          <div key={i} className="flex items-start gap-3 px-3.5 py-2.5 rounded-xl bg-white/[0.03] border border-white/[0.06]">
            <span className="text-xs font-bold text-blue-400 mt-0.5 flex-shrink-0">{i + 1}.</span>
            <span className="text-sm text-white/70">{step}</span>
          </div>
        ))}
      </div>

      <a
        href="https://portal.azure.com"
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl mb-3
          border border-blue-500/30 text-blue-300 hover:bg-blue-500/10 transition-all text-sm"
      >
        <ExternalLink className="w-4 h-4" />
        Open Azure Portal
      </a>

      <button
        onClick={() => fetch('/api/folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: `${getDevflowHome()}/.DevData/docs/DevFlow/setup-guides/setup-guide-teams.md` }) })}
        className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl mb-6
          text-white/40 hover:text-white/60 transition-all text-sm"
      >
        <ExternalLink className="w-3.5 h-3.5" />
        Full Setup Guide
      </button>

      <div className="flex items-center gap-3">
        <button onClick={onCancel} className="glass-button px-4 py-2.5 text-sm text-white/60 hover:text-white/80">
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

// ─── Step 2: Credentials ─────────────────────────────────────────────────────

const GRAPH_PERMISSIONS = `ChannelMessage.Read.All, ChannelMessage.Send, Team.ReadBasic.All, Channel.ReadBasic.All`;

function Step2Credentials({
  tenantId, clientId, clientSecret,
  setTenantId, setClientId, setClientSecret,
  onBack, onNext,
}: {
  tenantId: string; clientId: string; clientSecret: string;
  setTenantId: (v: string) => void; setClientId: (v: string) => void; setClientSecret: (v: string) => void;
  onBack: () => void; onNext: () => void;
}) {
  const inputStyle = {
    background: 'rgba(10,20,40,0.5)',
    border: '1px solid rgba(59,130,246,0.2)',
    outline: 'none',
  };

  return (
    <div className="flex flex-col">
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-white mb-1">Azure Credentials</h2>
        <p className="text-xs text-white/40">From your app registration</p>
      </div>

      <div className="space-y-4 mb-5">
        <div>
          <label htmlFor="teams-tenant-id" className="block text-sm font-medium text-white/80 mb-1.5">Tenant ID <span className="text-blue-400">*</span></label>
          <input
            id="teams-tenant-id"
            type="text"
            value={tenantId}
            onChange={(e) => setTenantId(e.target.value)}
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            className="glass-input w-full px-3.5 py-2.5 rounded-xl text-sm font-mono text-white/80 placeholder:text-white/20"
            style={inputStyle}
          />
          <p className="text-xs text-white/35 mt-1.5">App registration → Overview → Directory (tenant) ID</p>
        </div>
        <div>
          <label htmlFor="teams-client-id" className="block text-sm font-medium text-white/80 mb-1.5">Client ID <span className="text-blue-400">*</span></label>
          <input
            id="teams-client-id"
            type="text"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            className="glass-input w-full px-3.5 py-2.5 rounded-xl text-sm font-mono text-white/80 placeholder:text-white/20"
            style={inputStyle}
          />
          <p className="text-xs text-white/35 mt-1.5">App registration → Overview → Application (client) ID</p>
        </div>
        <div>
          <label htmlFor="teams-client-secret" className="block text-sm font-medium text-white/80 mb-1.5">Client Secret <span className="text-blue-400">*</span></label>
          <input
            id="teams-client-secret"
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder="Your secret value"
            className="glass-input w-full px-3.5 py-2.5 rounded-xl text-sm font-mono text-white/80 placeholder:text-white/20"
            style={inputStyle}
          />
          <p className="text-xs text-white/35 mt-1.5">Certificates &amp; secrets → New client secret → copy the Value (not ID)</p>
        </div>
      </div>

      <div className="mb-5">
        <p className="text-xs font-medium text-white/60 mb-2">
          Also add these <span className="text-white/80">Graph API permissions</span> under API permissions → Add permission → Microsoft Graph → Application:
        </p>
        <CopyBlock text={GRAPH_PERMISSIONS} />
        <p className="text-xs text-amber-400/70 mt-2">
          After adding permissions, click <span className="font-medium">Grant admin consent</span>.
        </p>
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

// ─── Step 3: Bot Service ──────────────────────────────────────────────────────

function Step3BotService({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const [manifest, setManifest] = useState<string | null>(null);
  const [loadingManifest, setLoadingManifest] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleGenerateManifest = async () => {
    setLoadingManifest(true);
    try {
      const res = await fetch('/api/bridges/teams/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'generate-manifest' }),
      });
      if (!res.ok) {
        setManifest('{"error":"Could not generate manifest — configure credentials first"}');
        return;
      }
      const data = await res.json();
      setManifest(JSON.stringify(data, null, 2));
    } catch {
      setManifest('{"error":"Request failed"}');
    } finally {
      setLoadingManifest(false);
    }
  };

  const handleCopyManifest = async () => {
    if (!manifest) return;
    await navigator.clipboard.writeText(manifest).catch(() => {/* non-fatal */});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex flex-col">
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-white mb-1">Create Bot Service</h2>
        <p className="text-xs text-white/40">Azure Bot (free F0 tier)</p>
      </div>

      <p className="text-sm text-white/60 leading-relaxed mb-5">
        Create an Azure Bot to handle the Teams messaging endpoint. Use the free F0 tier.
      </p>

      <div className="space-y-2.5 mb-5">
        {[
          'In Azure Portal → Create a resource → Azure Bot',
          'Select F0 (free) pricing tier',
          'Use your existing App Registration (enter the Client ID from Step 2)',
          'The messaging endpoint will be set in the next step',
        ].map((step, i) => (
          <div key={i} className="flex items-start gap-3 px-3.5 py-2.5 rounded-xl bg-white/[0.03] border border-white/[0.06]">
            <span className="text-xs font-bold text-blue-400 mt-0.5 flex-shrink-0">{i + 1}.</span>
            <span className="text-sm text-white/70">{step}</span>
          </div>
        ))}
      </div>

      <div className="mb-5">
        <p className="text-xs text-white/50 mb-2">Generate app manifest (optional — for Teams app installation):</p>
        <button
          onClick={handleGenerateManifest}
          disabled={loadingManifest}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs border border-blue-500/30 text-blue-300 hover:bg-blue-500/10 transition-all disabled:opacity-50"
        >
          {loadingManifest ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
          Generate Manifest
        </button>
        {manifest && (
          <div className="relative mt-2 rounded-xl overflow-hidden border border-blue-500/20 bg-blue-500/5">
            <pre className="px-4 py-3 text-[10px] text-blue-200 font-mono overflow-x-auto max-h-32 leading-relaxed pr-12">
              {manifest}
            </pre>
            <button
              onClick={handleCopyManifest}
              className="absolute top-2 right-2 p-1.5 rounded-lg bg-blue-500/20 hover:bg-blue-500/35 text-blue-300 transition-all"
            >
              {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
            </button>
          </div>
        )}
      </div>

      <a
        href="https://portal.azure.com"
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl mb-6
          border border-blue-500/30 text-blue-300 hover:bg-blue-500/10 transition-all text-sm"
      >
        <ExternalLink className="w-4 h-4" />
        Open Azure Portal
      </a>

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

// ─── Step 4: Validate ─────────────────────────────────────────────────────────

function Step4Validate({
  tenantId, clientId, clientSecret,
  onBack, onSuccess,
}: {
  tenantId: string; clientId: string; clientSecret: string;
  onBack: () => void;
  onSuccess: (tunnelUrl: string) => void;
}) {
  const [validating, setValidating] = useState(false);
  const [validated, setValidated] = useState(false);
  const [error, setError] = useState('');
  const [tunnelUrl, setTunnelUrl] = useState('');
  const [saving, setSaving] = useState(false);

  const handleValidate = async () => {
    setValidating(true);
    setError('');
    try {
      const res = await fetch('/api/bridges/teams/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId, clientId, clientSecret }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `Failed (${res.status})`);
      }
      const data = await res.json() as { tunnelUrl?: string };
      setTunnelUrl(data.tunnelUrl ?? '');
      setValidated(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Validation failed');
    } finally {
      setValidating(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/bridges/teams/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId, clientId, clientSecret, tunnelUrl }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `Failed (${res.status})`);
      }
      onSuccess(tunnelUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col">
      <div className="mb-6">
        <h2 className="text-xl font-semibold text-white mb-1">Validate &amp; Save</h2>
        <p className="text-xs text-white/40">Confirm Azure credentials and set tunnel URL</p>
      </div>

      {!validated ? (
        <>
          <p className="text-sm text-white/60 leading-relaxed mb-6">
            Click below to test your Azure credentials. {PRODUCT_NAME} will attempt to authenticate with the Microsoft Graph API.
          </p>

          {error && (
            <div className="flex items-start gap-2.5 px-3.5 py-3 rounded-xl bg-red-500/10 border border-red-500/20 mb-4">
              <AlertTriangle className="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0" />
              <p className="text-xs text-red-300">{error}</p>
            </div>
          )}

          <div className="flex items-center gap-3">
            <button onClick={onBack} disabled={validating} className="glass-button px-4 py-2.5 text-sm text-white/60 hover:text-white/80 disabled:opacity-40">
              Back
            </button>
            <button
              onClick={handleValidate}
              disabled={validating}
              className="glass-button primary flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-60"
            >
              {validating ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Validating...</>
              ) : (
                'Validate Credentials'
              )}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center gap-2 px-4 py-3 rounded-xl bg-green-500/10 border border-green-500/20 mb-5">
            <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />
            <p className="text-sm text-green-300 font-medium">Credentials validated successfully</p>
          </div>

          <div className="mb-5">
            <label className="block text-sm font-medium text-white/80 mb-1.5">
              Tunnel URL
            </label>
            <input
              type="text"
              value={tunnelUrl}
              onChange={(e) => setTunnelUrl(e.target.value)}
              placeholder="https://your-devflow-url.ngrok.io"
              className="glass-input w-full px-3.5 py-2.5 rounded-xl text-sm font-mono text-white/80 placeholder:text-white/20"
              style={{
                background: 'rgba(10,20,40,0.5)',
                border: '1px solid rgba(59,130,246,0.2)',
                outline: 'none',
              }}
            />
            <p className="text-xs text-white/35 mt-1.5">
              Your {PRODUCT_NAME} server&apos;s public HTTPS URL. Teams will post events here. Use ngrok or Azure Dev Tunnels.
            </p>
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
                <><Loader2 className="w-4 h-4 animate-spin" /> Saving...</>
              ) : (
                <>Save Configuration <ChevronRight className="w-4 h-4" /></>
              )}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Step 5: Done ─────────────────────────────────────────────────────────────

function Step5Done({ onComplete }: { onComplete: () => void }) {
  return (
    <div className="flex flex-col items-center text-center">
      <div className="relative mb-6">
        <div className="absolute inset-0 rounded-full bg-blue-500/20 blur-xl animate-pulse" />
        <div className="relative p-5 rounded-full bg-blue-500/15 border-2 border-blue-500/40">
          <CheckCircle className="w-12 h-12 text-blue-400" />
        </div>
      </div>

      <h2 className="text-2xl font-semibold text-white mb-2">Teams is connected!</h2>

      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-green-500/20 text-green-300 border border-green-500/30 text-sm font-medium mb-5">
        <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
        Active
      </span>

      <p className="text-sm text-white/55 max-w-xs leading-relaxed mb-8">
        Microsoft Teams is now bridged to {PRODUCT_NAME}. Set up channel mappings to route messages to your collab channels.
      </p>

      <button
        onClick={onComplete}
        className="glass-button primary px-8 py-3 text-sm font-medium text-white w-full max-w-xs"
      >
        Open Teams Panel
      </button>
    </div>
  );
}

// ─── Main Wizard ──────────────────────────────────────────────────────────────

export function TeamsSetupWizard({ onComplete, onCancel }: TeamsSetupWizardProps) {
  const [step, setStep] = useState<Step>(1);
  const [tenantId, setTenantId] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');

  return (
    <div className="flex flex-col w-full max-w-[600px] mx-auto">
      <StepIndicator current={step} />
      <div
        className="glass-card p-8"
        style={{ background: 'rgba(8,14,28,0.97)', backdropFilter: 'none', WebkitBackdropFilter: 'none' }}
      >
        {step === 1 && <Step1AzureApp onNext={() => setStep(2)} onCancel={onCancel} />}
        {step === 2 && (
          <Step2Credentials
            tenantId={tenantId} clientId={clientId} clientSecret={clientSecret}
            setTenantId={setTenantId} setClientId={setClientId} setClientSecret={setClientSecret}
            onBack={() => setStep(1)} onNext={() => setStep(3)}
          />
        )}
        {step === 3 && <Step3BotService onBack={() => setStep(2)} onNext={() => setStep(4)} />}
        {step === 4 && (
          <Step4Validate
            tenantId={tenantId} clientId={clientId} clientSecret={clientSecret}
            onBack={() => setStep(3)}
            onSuccess={() => setStep(5)}
          />
        )}
        {step === 5 && <Step5Done onComplete={onComplete} />}
      </div>
    </div>
  );
}
