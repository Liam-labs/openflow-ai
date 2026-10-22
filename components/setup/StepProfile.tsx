'use client';

import { useState } from 'react';
import { User } from 'lucide-react';
import type { SetupData } from '@/components/SetupWizard';
import { SetupSelect } from '@/components/setup/SetupSelect';

interface StepProfileProps {
  data: SetupData['profile'];
  onChange: (data: SetupData['profile']) => void;
}

const ROLE_OPTIONS = [
  'Solo Developer',
  'Agency Owner',
  'Team Lead',
  'DevOps Engineer',
  'Other',
];

export function StepProfile({ data, onChange }: StepProfileProps) {
  const [errors, setErrors] = useState<{ name?: string; role?: string }>({});

  const update = (field: keyof SetupData['profile'], value: string) => {
    onChange({ ...data, [field]: value });
    // Clear error on correction
    if (errors[field as keyof typeof errors]) {
      setErrors((e) => ({ ...e, [field]: undefined }));
    }
  };

  return (
    <div className="glass-card p-8 relative z-10">
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
          <User className="w-6 h-6 text-[#60a5fa]" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-white leading-tight">About you</h2>
          <p className="text-sm text-white/40 mt-0.5">Your name is how your agents will address you.</p>
        </div>
      </div>

      {/* Fields */}
      <div className="flex flex-col gap-5">
        {/* Your name */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="profile-name" className="text-sm text-white/60 font-medium">
            Your name <span className="text-red-400" aria-hidden="true">*</span>
          </label>
          <input
            id="profile-name"
            type="text"
            className={`glass-input${errors.name ? ' error' : ''}`}
            placeholder="e.g. Alex"
            value={data.name}
            onChange={(e) => update('name', e.target.value)}
            aria-required="true"
            aria-describedby={errors.name ? 'profile-name-error' : undefined}
            autoComplete="given-name"
          />
          {errors.name && (
            <p id="profile-name-error" className="text-xs text-red-400" role="alert">
              {errors.name}
            </p>
          )}
        </div>

        {/* Role */}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="profile-role" className="text-sm text-white/60 font-medium">
            Role <span className="text-red-400" aria-hidden="true">*</span>
          </label>
          <SetupSelect
            id="profile-role"
            value={data.role}
            options={ROLE_OPTIONS.map((r) => ({ value: r, label: r }))}
            onChange={(v) => update('role', v)}
            placeholder="Select your role"
            invalid={!!errors.role}
            describedBy={errors.role ? 'profile-role-error' : undefined}
          />
          {errors.role && (
            <p id="profile-role-error" className="text-xs text-red-400" role="alert">
              {errors.role}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
