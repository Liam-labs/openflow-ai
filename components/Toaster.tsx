'use client';

import React from 'react';
import { CheckCircle, XCircle, Info, AlertTriangle, X } from 'lucide-react';
import { useToast, type Toast, type ToastVariant } from '@/lib/contexts/ToastContext';

// ─── Icon map ─────────────────────────────────────────────────────────────────

const ICON: Record<ToastVariant, React.ReactNode> = {
  success: <CheckCircle size={15} aria-hidden="true" />,
  error:   <XCircle    size={15} aria-hidden="true" />,
  info:    <Info       size={15} aria-hidden="true" />,
  warning: <AlertTriangle size={15} aria-hidden="true" />,
};

// ─── Single toast ─────────────────────────────────────────────────────────────

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  return (
    <div className={`df-toast df-toast--${toast.variant}`} role="alert" aria-live="assertive">
      <span className="df-toast__icon">{ICON[toast.variant]}</span>
      <span className="df-toast__message">{toast.message}</span>
      <button
        className="df-toast__dismiss"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss"
      >
        <X size={12} />
      </button>
    </div>
  );
}

// ─── Container ────────────────────────────────────────────────────────────────

export function Toaster() {
  const { toasts, dismiss } = useToast();

  if (toasts.length === 0) return null;

  return (
    <div className="df-toast-container" aria-label="Notifications">
      {toasts.map(t => (
        <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
      ))}
    </div>
  );
}
