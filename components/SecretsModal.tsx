'use client';

import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, Shield, ShieldAlert, ShieldCheck, AlertTriangle, Info, FileCode, Download, Loader2 } from 'lucide-react';
import { Project, SecretFinding } from '@/lib/types';
import { PRODUCT_NAME } from '@/lib/brand';

interface SecretsModalProps {
  project: Project;
  onClose: () => void;
}

interface ScanResponse {
  projectId: string;
  projectName: string;
  findings: SecretFinding[];
  filesScanned: number;
  duration: number;
  timestamp: string;
  summary: {
    total: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
  error?: string;
}

type SeverityFilter = 'all' | 'critical' | 'high' | 'medium' | 'low';

export function SecretsModal({ project, onClose }: SecretsModalProps) {
  const [isScanning, setIsScanning] = useState(true);
  const [scanResult, setScanResult] = useState<ScanResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('all');
  const [expandedFindings, setExpandedFindings] = useState<Set<number>>(new Set());

  useEffect(() => {
    runScan();
  }, []);

  const runScan = async () => {
    setIsScanning(true);
    setError(null);

    try {
      const response = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project.id }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Scan failed');
      }

      setScanResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsScanning(false);
    }
  };

  const getSeverityIcon = (severity: string) => {
    switch (severity) {
      case 'critical':
        return <ShieldAlert className="w-4 h-4 text-error" />;
      case 'high':
        return <AlertTriangle className="w-4 h-4 text-error" />;
      case 'medium':
        return <Shield className="w-4 h-4 text-warning" />;
      case 'low':
        return <Info className="w-4 h-4 text-accent" />;
      default:
        return <Shield className="w-4 h-4 text-muted" />;
    }
  };

  const getSeverityClass = (severity: string) => {
    switch (severity) {
      case 'critical':
        return 'bg-error/20 text-error border-error/30';
      case 'high':
        return 'bg-error/10 text-error border-error/20';
      case 'medium':
        return 'bg-warning/20 text-warning border-warning/30';
      case 'low':
        return 'bg-accent/10 text-accent border-accent/20';
      default:
        return 'bg-muted/20 text-muted border-muted/30';
    }
  };

  const toggleFinding = (index: number) => {
    setExpandedFindings(prev => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const filteredFindings = scanResult?.findings.filter(f =>
    severityFilter === 'all' || f.severity === severityFilter
  ) || [];

  const exportToMarkdown = () => {
    if (!scanResult) return;

    const date = new Date().toISOString().split('T')[0];
    const time = new Date().toLocaleTimeString();

    let md = `# Secrets Scan Report\n\n`;
    md += `**Project:** ${project.name}\n`;
    md += `**Path:** ${project.path}\n`;
    md += `**Date:** ${date} at ${time}\n`;
    md += `**Files Scanned:** ${scanResult.filesScanned}\n`;
    md += `**Duration:** ${scanResult.duration}ms\n\n`;

    md += `## Summary\n\n`;
    md += `| Severity | Count |\n`;
    md += `|----------|-------|\n`;
    md += `| Critical | ${scanResult.summary.critical} |\n`;
    md += `| High | ${scanResult.summary.high} |\n`;
    md += `| Medium | ${scanResult.summary.medium} |\n`;
    md += `| Low | ${scanResult.summary.low} |\n`;
    md += `| **Total** | **${scanResult.summary.total}** |\n\n`;

    if (scanResult.findings.length === 0) {
      md += `## Findings\n\n`;
      md += `No secrets detected.\n`;
    } else {
      // Group findings by severity
      const grouped = {
        critical: scanResult.findings.filter(f => f.severity === 'critical'),
        high: scanResult.findings.filter(f => f.severity === 'high'),
        medium: scanResult.findings.filter(f => f.severity === 'medium'),
        low: scanResult.findings.filter(f => f.severity === 'low'),
      };

      for (const [severity, findings] of Object.entries(grouped)) {
        if (findings.length === 0) continue;

        md += `## ${severity.charAt(0).toUpperCase() + severity.slice(1)} Severity (${findings.length})\n\n`;

        for (const finding of findings) {
          md += `### ${finding.ruleId}\n\n`;
          md += `- **Description:** ${finding.description}\n`;
          md += `- **File:** \`${finding.file}\`\n`;
          md += `- **Location:** Line ${finding.line}, Column ${finding.column}\n`;
          md += `- **Match (redacted):** \`${finding.match}\`\n\n`;
          md += `**Context:**\n\`\`\`\n${finding.snippet}\n\`\`\`\n\n`;
          md += `---\n\n`;
        }
      }
    }

    md += `\n---\n*Generated by ${PRODUCT_NAME} Secrets Scanner*\n`;

    // Trigger download
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `secrets-scan-${project.id}-${date}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Use portal to render at document body level, avoiding parent's backdrop-filter
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative glass-card w-full max-w-4xl max-h-[85vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-card-border">
          <div className="flex items-center gap-3">
            <Shield className="w-5 h-5 text-accent" />
            <div>
              <h2 className="text-lg font-semibold">Secrets Scanner</h2>
              <p className="text-xs text-muted">{project.name}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-card-hover rounded-lg transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {isScanning ? (
            <div className="flex flex-col items-center justify-center py-12">
              <Loader2 className="w-8 h-8 text-accent animate-spin mb-4" />
              <p className="text-muted">Scanning for secrets...</p>
              <p className="text-xs text-muted mt-1">This may take a few seconds</p>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-12">
              <ShieldAlert className="w-8 h-8 text-error mb-4" />
              <p className="text-error font-medium">Scan Failed</p>
              <p className="text-sm text-muted mt-1">{error}</p>
              <button
                onClick={runScan}
                className="mt-4 glass-button text-sm"
              >
                Try Again
              </button>
            </div>
          ) : scanResult ? (
            <>
              {/* Summary */}
              <div className="grid grid-cols-5 gap-3 mb-6">
                <div
                  onClick={() => setSeverityFilter('all')}
                  className={`p-3 rounded-lg border cursor-pointer transition-colors ${
                    severityFilter === 'all'
                      ? 'bg-card-hover border-accent'
                      : 'bg-card-bg border-card-border hover:border-accent/50'
                  }`}
                >
                  <p className="text-2xl font-bold">{scanResult.summary.total}</p>
                  <p className="text-xs text-muted">Total</p>
                </div>
                <div
                  onClick={() => setSeverityFilter('critical')}
                  className={`p-3 rounded-lg border cursor-pointer transition-colors ${
                    severityFilter === 'critical'
                      ? 'bg-error/20 border-error'
                      : 'bg-error/10 border-error/20 hover:border-error/50'
                  }`}
                >
                  <p className="text-2xl font-bold text-error">{scanResult.summary.critical}</p>
                  <p className="text-xs text-error/70">Critical</p>
                </div>
                <div
                  onClick={() => setSeverityFilter('high')}
                  className={`p-3 rounded-lg border cursor-pointer transition-colors ${
                    severityFilter === 'high'
                      ? 'bg-error/20 border-error'
                      : 'bg-error/5 border-error/10 hover:border-error/30'
                  }`}
                >
                  <p className="text-2xl font-bold text-error/80">{scanResult.summary.high}</p>
                  <p className="text-xs text-error/60">High</p>
                </div>
                <div
                  onClick={() => setSeverityFilter('medium')}
                  className={`p-3 rounded-lg border cursor-pointer transition-colors ${
                    severityFilter === 'medium'
                      ? 'bg-warning/20 border-warning'
                      : 'bg-warning/10 border-warning/20 hover:border-warning/50'
                  }`}
                >
                  <p className="text-2xl font-bold text-warning">{scanResult.summary.medium}</p>
                  <p className="text-xs text-warning/70">Medium</p>
                </div>
                <div
                  onClick={() => setSeverityFilter('low')}
                  className={`p-3 rounded-lg border cursor-pointer transition-colors ${
                    severityFilter === 'low'
                      ? 'bg-accent/20 border-accent'
                      : 'bg-accent/10 border-accent/20 hover:border-accent/50'
                  }`}
                >
                  <p className="text-2xl font-bold text-accent">{scanResult.summary.low}</p>
                  <p className="text-xs text-accent/70">Low</p>
                </div>
              </div>

              {/* Stats bar */}
              <div className="flex items-center gap-4 text-xs text-muted mb-4">
                <span>{scanResult.filesScanned} files scanned</span>
                <span>•</span>
                <span>{scanResult.duration}ms</span>
              </div>

              {/* Findings list */}
              {filteredFindings.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12">
                  <ShieldCheck className="w-12 h-12 text-success mb-4" />
                  <p className="text-lg font-medium text-success">
                    {severityFilter === 'all' ? 'No secrets found!' : `No ${severityFilter} severity issues`}
                  </p>
                  <p className="text-sm text-muted mt-1">
                    {severityFilter === 'all'
                      ? 'Your codebase looks clean'
                      : 'Try selecting a different severity level'}
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {filteredFindings.map((finding, index) => (
                    <div
                      key={index}
                      className={`rounded-lg border p-3 ${getSeverityClass(finding.severity)}`}
                    >
                      <div
                        className="flex items-start gap-3 cursor-pointer"
                        onClick={() => toggleFinding(index)}
                      >
                        {getSeverityIcon(finding.severity)}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-medium">{finding.ruleId}</span>
                            <span className={`text-xs px-1.5 py-0.5 rounded uppercase font-medium ${getSeverityClass(finding.severity)}`}>
                              {finding.severity}
                            </span>
                          </div>
                          <p className="text-xs opacity-70">{finding.description}</p>
                          <div className="flex items-center gap-2 mt-2 text-xs font-mono">
                            <FileCode className="w-3 h-3" />
                            <span className="truncate">{finding.file}:{finding.line}:{finding.column}</span>
                          </div>
                        </div>
                      </div>

                      {expandedFindings.has(index) && (
                        <div className="mt-3 pt-3 border-t border-current/20">
                          <p className="text-xs font-medium mb-2">Matched Secret (redacted):</p>
                          <code className="block text-xs bg-black/20 p-2 rounded font-mono break-all">
                            {finding.match}
                          </code>
                          <p className="text-xs font-medium mt-3 mb-2">Context:</p>
                          <code className="block text-xs bg-black/20 p-2 rounded font-mono break-all whitespace-pre-wrap">
                            {finding.snippet}
                          </code>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : null}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-4 border-t border-card-border bg-card-bg/50">
          <p className="text-xs text-muted">
            Secrets are redacted for screen-sharing safety
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={runScan}
              disabled={isScanning}
              className="glass-button text-sm flex items-center gap-2"
            >
              {isScanning ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Shield className="w-4 h-4" />
              )}
              Rescan
            </button>
            <button
              onClick={exportToMarkdown}
              disabled={isScanning || !scanResult}
              className="glass-button text-sm flex items-center gap-2"
            >
              <Download className="w-4 h-4" />
              Export
            </button>
            <button
              onClick={onClose}
              className="glass-button text-sm"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
