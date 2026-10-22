'use client';

import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  ImageOff,
} from 'lucide-react';

import {
  buildContactSheetScreenshots,
  describeDecision,
  type ContactSheetScreenshot,
} from '@/lib/delivery-evidence/skill';
import type {
  EvidenceDecision,
  EvidenceFinding,
  EvidenceSeverity,
  VisualReviewRunResponse,
} from '@/lib/delivery-evidence/types';

export interface ContactSheetProps {
  response: VisualReviewRunResponse;
}

const SEVERITY_ORDER: Record<EvidenceSeverity, number> = { p0: 0, p1: 1, p2: 2, p3: 3 };
const SEVERITY_LABELS: Record<EvidenceSeverity, string> = {
  p0: 'P0', p1: 'P1', p2: 'P2', p3: 'P3',
};
const VIEWPORT_ORDER: Record<string, number> = { mobile: 0, tablet: 1, desktop: 2 };

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function groupByRoute(screenshots: ContactSheetScreenshot[]): Map<string, ContactSheetScreenshot[]> {
  const grouped = new Map<string, ContactSheetScreenshot[]>();
  for (const shot of screenshots) {
    const bucket = grouped.get(shot.route) ?? [];
    bucket.push(shot);
    grouped.set(shot.route, bucket);
  }
  for (const bucket of grouped.values()) {
    bucket.sort((a, b) => (VIEWPORT_ORDER[a.viewport.id] ?? 99) - (VIEWPORT_ORDER[b.viewport.id] ?? 99));
  }
  return grouped;
}

function PendingState({ response }: { response: Extract<VisualReviewRunResponse, { success: false }> }) {
  return (
    <div className="dvc-pending">
      <AlertTriangle size={16} className="dvc-pending__icon" />
      <div>
        <p className="dvc-pending__title">Implementation ready; visual verification pending</p>
        <p className="dvc-pending__detail">
          {response.error} <span className="dvc-pending__code">{response.code}</span>
          {response.retryable ? ' · retry once the renderer is available' : ' · not retryable'}
        </p>
      </div>
    </div>
  );
}

function DecisionBadge({ decision }: { decision: EvidenceDecision }) {
  const { label, tone } = describeDecision(decision);
  return <span className={`dvc-decision dvc-decision--${tone}`}>{label}</span>;
}

function FindingRow({ finding }: { finding: EvidenceFinding }) {
  return (
    <div className={`dvc-finding dvc-finding--${finding.severity}`}>
      <span className="dvc-finding__severity">{SEVERITY_LABELS[finding.severity]}</span>
      <div className="dvc-finding__body">
        <span className="dvc-finding__summary">{finding.summary}</span>
        <span className="dvc-finding__meta">
          {finding.code}
          {finding.location?.route ? ` · ${finding.location.route}` : ''}
          {finding.status !== 'unresolved' ? ` · ${finding.status}` : ''}
        </span>
      </div>
    </div>
  );
}

function Thumbnail({ shot }: { shot: ContactSheetScreenshot }) {
  if (!shot.url) {
    return (
      <div className="dvc-thumb dvc-thumb--missing">
        <ImageOff size={18} />
        <span>artifact unavailable</span>
      </div>
    );
  }
  return (
    <a className="dvc-thumb" href={shot.url} target="_blank" rel="noreferrer">
      {/* eslint-disable-next-line @next/next/no-img-element -- dynamically served evidence artifact, not a static asset */}
      <img src={shot.url} alt={`${shot.route} — ${shot.viewport.id}`} loading="lazy" />
      <span className="dvc-thumb__caption">
        {shot.viewport.id} {shot.viewport.width}×{shot.viewport.height}
        {shot.fullPage ? ' · full page' : ''}
      </span>
      <ExternalLink size={11} className="dvc-thumb__ext" />
    </a>
  );
}

/** Minimal contact sheet: screenshot thumbnail grid + findings summary for
 * one Visual Review run. Renders the plan's advisory-pilot circuit-breaker
 * state when the renderer was unavailable instead of throwing on a failure
 * response. */
export function ContactSheet({ response }: ContactSheetProps) {
  const [findingsExpanded, setFindingsExpanded] = useState(false);

  const screenshots = useMemo(
    () => (response.success ? buildContactSheetScreenshots(response.result, response.receipt) : []),
    [response],
  );
  const routes = useMemo(() => groupByRoute(screenshots), [screenshots]);
  const findings = useMemo(
    () => (response.success
      ? [...response.receipt.findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
      : []),
    [response],
  );
  const visibleFindings = findingsExpanded ? findings : findings.slice(0, 3);
  const severityCounts = useMemo(() => {
    const counts: Record<EvidenceSeverity, number> = { p0: 0, p1: 0, p2: 0, p3: 0 };
    for (const finding of findings) counts[finding.severity] += 1;
    return counts;
  }, [findings]);

  return (
    <div className="dvc-card">
      <div className="dvc-header">
        <div className="dvc-header__left">
          <Camera size={14} className="dvc-header__icon" />
          <span className="dvc-header__title">Visual Review</span>
        </div>
        {response.success && <DecisionBadge decision={response.receipt.decision} />}
      </div>

      {!response.success && <PendingState response={response} />}

      {response.success && (
        <>
          <div className="dvc-stats-bar">
            <span className="dvc-stat-pill">{screenshots.length} screenshot{screenshots.length === 1 ? '' : 's'}</span>
            {(['p0', 'p1', 'p2', 'p3'] as const).filter((sev) => severityCounts[sev] > 0).map((sev) => (
              <span key={sev} className={`dvc-stat-pill dvc-stat-pill--${sev}`}>
                {severityCounts[sev]} {SEVERITY_LABELS[sev]}
              </span>
            ))}
            {response.result.consoleErrors.length > 0 && (
              <span className="dvc-stat-pill dvc-stat-pill--p1">
                {response.result.consoleErrors.length} console error{response.result.consoleErrors.length === 1 ? '' : 's'}
              </span>
            )}
            {response.result.networkFailures.length > 0 && (
              <span className="dvc-stat-pill dvc-stat-pill--p1">
                {response.result.networkFailures.length} network failure{response.result.networkFailures.length === 1 ? '' : 's'}
              </span>
            )}
            {findings.length === 0 && <span className="dvc-stat-pill dvc-stat-pill--clean">clean</span>}
          </div>

          {routes.size > 0 && (
            <div className="dvc-routes">
              {Array.from(routes.entries()).map(([route, shots]) => (
                <div key={route} className="dvc-route">
                  <span className="dvc-route__label">{route}</span>
                  <div className="dvc-grid">
                    {shots.map((shot) => <Thumbnail key={shot.artifactId} shot={shot} />)}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="dvc-findings">
            {findings.length === 0 ? (
              <p className="dvc-findings__empty">No findings — nothing to disclose.</p>
            ) : (
              <>
                {visibleFindings.map((finding) => <FindingRow key={finding.id} finding={finding} />)}
                {findings.length > 3 && (
                  <button
                    type="button"
                    className="dvc-findings__toggle"
                    onClick={() => setFindingsExpanded((value) => !value)}
                  >
                    {findingsExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    {findingsExpanded ? 'Show fewer' : `Show ${findings.length - 3} more`}
                  </button>
                )}
              </>
            )}
          </div>

          <div className="dvc-footer">
            <span>receipt {response.receipt.id}</span>
            <span>{formatTime(response.receipt.createdAt)}</span>
          </div>
        </>
      )}
    </div>
  );
}
