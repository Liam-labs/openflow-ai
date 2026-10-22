'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronRight, ChevronLeft, SkipForward, AlertTriangle, Loader2 } from 'lucide-react';

import { StepIndicator, type WizardStep } from '@/components/setup/StepIndicator';
import { StepProfile } from '@/components/setup/StepProfile';
import { StepCredentials } from '@/components/setup/StepCredentials';
import { StepMeetTeam } from '@/components/setup/StepMeetTeam';
import { StepComplete } from '@/components/setup/StepComplete';
import { PRODUCT_NAME } from '@/lib/brand';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SetupData {
  profile: {
    name: string;
    role: string;
  };
  credentials: {
    anthropicKey: string;
    openrouterKey: string;
    grokKey: string;
    ollamaUrl: string;
  };
}

const INITIAL_DATA: SetupData = {
  profile: { name: '', role: 'Solo Developer' },
  credentials: { anthropicKey: '', openrouterKey: '', grokKey: '', ollamaUrl: '' },
};

// Total wizard steps (not counting the completion screen)
const TOTAL_STEPS = 3;

type ViewState = WizardStep | 'complete';

// ─── Skip Confirmation Inline Banner ─────────────────────────────────────────

function SkipConfirmBanner({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.15 }}
      className="flex items-start gap-3 px-4 py-3 rounded-xl mb-4"
      style={{
        background: 'rgba(234,179,8,0.08)',
        border: '1px solid rgba(234,179,8,0.25)',
      }}
    >
      <AlertTriangle className="w-4 h-4 text-yellow-400 mt-0.5 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-xs text-white/70 leading-relaxed">
          Skip setup? You can run it later from{' '}
          <span className="text-white/90 font-medium">Settings</span>.
        </p>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <button
          onClick={onCancel}
          className="text-xs text-white/50 hover:text-white/80 transition-colors px-2 py-1"
        >
          Stay
        </button>
        <button
          onClick={onConfirm}
          className="glass-button px-3 py-1 text-xs text-yellow-300 hover:text-yellow-200"
          style={{
            background: 'rgba(234,179,8,0.15)',
            borderColor: 'rgba(234,179,8,0.3)',
          }}
        >
          Skip
        </button>
      </div>
    </motion.div>
  );
}

// ─── Main Wizard ─────────────────────────────────────────────────────────────

export function SetupWizard() {
  const router = useRouter();
  const [view, setView] = useState<ViewState>(1);
  const [data, setData] = useState<SetupData>(INITIAL_DATA);
  const [showSkipConfirm, setShowSkipConfirm] = useState(false);
  const [firstChannelId, setFirstChannelId] = useState<string | null>(null);
  // Track direction for slide animation: 1 = forward, -1 = backward
  const [direction, setDirection] = useState<1 | -1>(1);

  const isComplete = view === 'complete';
  const currentStep = isComplete ? TOTAL_STEPS : (view as WizardStep);

  // ── Data updaters ────────────────────────────────────────────────────────

  const updateProfile = (profile: SetupData['profile']) =>
    setData((d) => ({ ...d, profile }));

  const updateCredentials = (credentials: SetupData['credentials']) =>
    setData((d) => ({ ...d, credentials }));

  // ── Save + Navigation ───────────────────────────────────────────────────

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  // Map frontend state to backend field names per step
  const getStepPayload = (step: WizardStep) => {
    switch (step) {
      case 1:
        return { name: data.profile.name, role: data.profile.role };
      case 2:
        return { anthropicApiKey: data.credentials.anthropicKey, openrouterApiKey: data.credentials.openrouterKey, grokApiKey: data.credentials.grokKey, ollamaUrl: data.credentials.ollamaUrl };
      default:
        return {};
    }
  };

  const goNext = async () => {
    if (isComplete || saving) return;
    setShowSkipConfirm(false);
    setSaveError('');
    setSaving(true);

    try {
      const step = view as WizardStep;
      const res = await fetch('/api/setup/save-step', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step, data: getStepPayload(step) }),
      });
      const result = await res.json();

      if (!result.success) {
        setSaveError(result.error || 'Failed to save');
        return;
      }

      setDirection(1);
      setView(((step as number) + 1) as WizardStep);
    } catch {
      setSaveError('Network error — could not save');
    } finally {
      setSaving(false);
    }
  };

  // The last step runs its own buttons; this finishes setup after the team has started.
  const finishSetup = async (channelId: string | null) => {
    setSaveError('');
    try {
      const completeRes = await fetch('/api/setup/complete', { method: 'POST' });
      const completeResult = await completeRes.json();
      if (!completeResult.success) {
        setSaveError(completeResult.error || 'Failed to complete setup');
        return;
      }
      setFirstChannelId(channelId);
      setDirection(1);
      setView('complete');
    } catch {
      setSaveError('Network error — could not finish setup');
    }
  };

  const goBack = () => {
    setShowSkipConfirm(false);
    setSaveError('');
    setDirection(-1);
    if (isComplete) {
      setView(TOTAL_STEPS as WizardStep);
    } else {
      const prev = (view as number) - 1;
      if (prev >= 1) setView(prev as WizardStep);
    }
  };

  const handleSkipConfirmed = () => {
    router.push('/operations');
  };

  const handleGoToDashboard = () => {
    router.push(firstChannelId ? `/?channel=${encodeURIComponent(firstChannelId)}` : '/operations');
  };

  // ── Step content ─────────────────────────────────────────────────────────

  const renderStep = () => {
    if (isComplete) {
      return <StepComplete onGoToDashboard={handleGoToDashboard} hasChannel={!!firstChannelId} />;
    }

    switch (view as WizardStep) {
      case 1:
        return <StepProfile data={data.profile} onChange={updateProfile} />;
      case 2:
        return <StepCredentials data={data.credentials} onChange={updateCredentials} />;
      case 3:
        return <StepMeetTeam onFinish={finishSetup} />;
    }
  };

  // ── Motion variants ──────────────────────────────────────────────────────

  const variants = {
    initial: (dir: number) => ({
      opacity: 0,
      x: dir * 24,
    }),
    animate: {
      opacity: 1,
      x: 0,
    },
    exit: (dir: number) => ({
      opacity: 0,
      x: dir * -24,
    }),
  };

  return (
    <div className="flex flex-col w-full">
      {/* Header */}
      <div className="text-center mb-6">
        <p className="text-xs text-white/30 uppercase tracking-widest font-medium mb-1">
          First-time setup
        </p>
        <h1 className="text-2xl font-semibold text-white">Welcome to {PRODUCT_NAME}</h1>
      </div>

      {/* Step indicator — hidden on complete screen */}
      {!isComplete && (
        <StepIndicator current={currentStep as WizardStep} />
      )}

      {/* Skip confirm banner */}
      <AnimatePresence>
        {showSkipConfirm && (
          <SkipConfirmBanner
            onConfirm={handleSkipConfirmed}
            onCancel={() => setShowSkipConfirm(false)}
          />
        )}
      </AnimatePresence>

      {/* Step content */}
      <AnimatePresence mode="wait" custom={direction}>
        <motion.div
          key={view}
          custom={direction}
          variants={variants}
          initial="initial"
          animate="animate"
          exit="exit"
          transition={{ duration: 0.2, ease: 'easeInOut' }}
        >
          {renderStep()}
        </motion.div>
      </AnimatePresence>

      {/* Footer navigation — hidden on complete screen */}
      {!isComplete && (
        <div className="flex items-center justify-between mt-5 pt-4 border-t border-white/[0.06]">
          {/* Back */}
          <button
            onClick={goBack}
            disabled={(view as number) <= 1}
            className="glass-button flex items-center gap-2 px-4 py-2.5 text-sm text-white/60 hover:text-white/80 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <ChevronLeft className="w-4 h-4" />
            Back
          </button>

          {/* Right group: Skip + Next */}
          <div className="flex items-center gap-2">
            {/* Skip */}
            <button
              onClick={() => setShowSkipConfirm(true)}
              className="glass-button flex items-center gap-1.5 px-3 py-2.5 text-sm text-white/40 hover:text-white/60"
            >
              <SkipForward className="w-3.5 h-3.5" />
              Skip
            </button>

            {/* Next — the last step has its own buttons */}
            {(view as number) < TOTAL_STEPS && (
            <button
              onClick={goNext}
              disabled={saving}
              className="glass-button primary flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-white disabled:opacity-60 disabled:cursor-wait"
            >
              {saving ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Saving…
                </>
              ) : (
                <>
                  Next
                  <ChevronRight className="w-4 h-4" />
                </>
              )}
            </button>
            )}
          </div>
          {saveError && (
            <p className="text-xs text-red-400 mt-2 text-right">{saveError}</p>
          )}
        </div>
      )}
    </div>
  );
}
