'use client';

import { useState } from 'react';
import { Key, Copy, Download, Check, AlertTriangle } from 'lucide-react';
import { formatCodesForExport } from '@/lib/vault/backup-codes';
import { copyToClipboard, downloadAsFile } from '@/lib/vault/storage';

interface BackupCodesDisplayProps {
  codes: string[];
  onComplete: () => void;
}

export function BackupCodesDisplay({ codes, onComplete }: BackupCodesDisplayProps) {
  const [copied, setCopied] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  const handleCopy = async () => {
    const text = formatCodesForExport(codes);
    await copyToClipboard(text, 60000); // Keep in clipboard for 1 minute
    setCopied(true);
    setTimeout(() => setCopied(false), 3000);
  };

  const handleDownload = () => {
    const text = formatCodesForExport(codes);
    downloadAsFile(text, 'devflow-backup-codes.txt');
  };

  return (
    <div className="space-y-6">
      <div className="text-center mb-6">
        <Key className="w-12 h-12 mx-auto mb-4 text-accent" />
        <h3 className="text-xl font-bold mb-2">Save Your Backup Codes</h3>
        <p className="text-sm text-muted">
          These codes can be used to unlock your vault if you forget your password
          or lose access to Windows Hello. Each code can only be used once.
        </p>
      </div>

      <div className="flex items-center gap-2 p-3 bg-warning/10 border border-warning/20 rounded-lg">
        <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0" />
        <p className="text-sm text-warning">
          Store these codes in a safe place. They cannot be recovered if lost!
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2 p-4 bg-card-bg rounded-lg font-mono text-sm">
        {codes.map((code, index) => (
          <div
            key={index}
            className="flex items-center gap-2 py-1"
          >
            <span className="text-muted w-5 text-right">{index + 1}.</span>
            <span className="tracking-wider">{code}</span>
          </div>
        ))}
      </div>

      <div className="flex gap-3">
        <button
          onClick={handleCopy}
          className="glass-button secondary flex-1 flex items-center justify-center gap-2"
        >
          {copied ? (
            <>
              <Check className="w-4 h-4 text-success" />
              <span>Copied!</span>
            </>
          ) : (
            <>
              <Copy className="w-4 h-4" />
              <span>Copy All</span>
            </>
          )}
        </button>
        <button
          onClick={handleDownload}
          className="glass-button secondary flex-1 flex items-center justify-center gap-2"
        >
          <Download className="w-4 h-4" />
          <span>Download</span>
        </button>
      </div>

      <label className="flex items-start gap-3 p-4 bg-card-bg rounded-lg cursor-pointer">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          className="mt-0.5 w-4 h-4 accent-accent"
        />
        <span className="text-sm">
          I have saved these backup codes in a secure location
          (e.g., password manager, printed copy in a safe)
        </span>
      </label>

      <button
        onClick={onComplete}
        disabled={!confirmed}
        className="glass-button primary w-full"
      >
        Continue to Vault
      </button>
    </div>
  );
}
