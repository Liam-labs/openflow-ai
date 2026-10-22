'use client';

import { useState, useCallback } from 'react';

const DISMISSED_KEY = 'devflow-onboarding-dismissed';
const COMPLETED_KEY = 'devflow-onboarding-completed';

export function useOnboarding() {
  const [dismissed, setDismissed] = useState(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem(DISMISSED_KEY) === 'true';
  });

  const [completed, setCompleted] = useState<string[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      return JSON.parse(localStorage.getItem(COMPLETED_KEY) || '[]');
    } catch {
      return [];
    }
  });

  const markComplete = useCallback((id: string) => {
    setCompleted((prev) => {
      if (prev.includes(id)) return prev;
      const next = [...prev, id];
      localStorage.setItem(COMPLETED_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const dismiss = useCallback(() => {
    localStorage.setItem(DISMISSED_KEY, 'true');
    setDismissed(true);
  }, []);

  return { dismissed, completed, markComplete, dismiss };
}
