'use client';

import { SetupWizard } from '@/components/SetupWizard';

export default function SetupPage() {
  return (
    <div
      className="min-h-screen bg-[#050510] flex items-center justify-center px-4 py-12"
      style={{
        background:
          'radial-gradient(ellipse at 30% 20%, rgba(59,130,246,0.08) 0%, transparent 55%), ' +
          'radial-gradient(ellipse at 70% 80%, rgba(37,99,235,0.06) 0%, transparent 55%), ' +
          '#050510',
      }}
    >
      <div className="w-full max-w-2xl">
        <SetupWizard />
      </div>
    </div>
  );
}
