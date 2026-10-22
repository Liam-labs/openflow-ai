/**
 * Delivery Evidence — Visual Review consumption for frontend agents.
 *
 * Pilot trigger (per docs/plan-frontend-visual-review.md): invoke
 * `invokeVisualReview` explicitly before requesting `done` on a visually
 * relevant task. This module is the thin client the ContactSheet component
 * and any future hook/skill markdown builds on top of — it owns the fetch
 * call, the frozen-error-contract mapping, and the receipt-to-UI joins.
 */
import { parseVisualReviewRunResponse } from '@/lib/delivery-evidence/schema';
import type {
  DeliveryEvidenceReceipt,
  EvidenceArtifact,
  EvidenceDecision,
  EvidenceSeverity,
  VisualReviewRunRequest,
  VisualReviewRunResponse,
  VisualReviewRunResult,
} from '@/lib/delivery-evidence/types';

const VISUAL_REVIEW_RUN_ENDPOINT = '/api/delivery-evidence/visual-review/run';
const ARTIFACT_ENDPOINT = '/api/delivery-evidence/artifact';
const ARTIFACT_URI_PATTERN = /^delivery-evidence:\/\/([^/]+)\/([^/]+)\/([^/]+)$/;
const DEFAULT_API_BASE = 'http://127.0.0.1:3000';

export type InvokeVisualReviewInput = Omit<VisualReviewRunRequest, 'schemaVersion'>;

export interface InvokeVisualReviewOptions {
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Origin to resolve the API path against outside a browser (Node/Codex
   * harnesses driving DevFlow directly have no implicit document origin, so
   * a bare relative path throws `ERR_INVALID_URL`). Ignored when `window`
   * exists — a browser resolves the relative path against its own origin,
   * which is always correct there. Default: env `DEVFLOW_API_URL`, then
   * `DEVFLOW_URL`, then `http://127.0.0.1:3000`.
   */
  apiBase?: string;
}

/** Relative in a browser (resolves against the page's own origin);
 * absolute against `apiBase`/`DEVFLOW_API_URL`/loopback everywhere else. */
function resolveEndpoint(path: string, apiBase?: string): string {
  if (typeof window !== 'undefined') return path;
  const base = apiBase ?? process.env.DEVFLOW_API_URL ?? process.env.DEVFLOW_URL ?? DEFAULT_API_BASE;
  return new URL(path, base).toString();
}

function rendererUnavailable(message: string): VisualReviewRunResponse {
  return {
    success: false,
    code: 'DELIVERY_EVIDENCE_RENDERER_UNAVAILABLE',
    error: message,
    retryable: true,
  };
}

function runnerFailed(message: string): VisualReviewRunResponse {
  return {
    success: false,
    code: 'DELIVERY_EVIDENCE_RUNNER_FAILED',
    error: message,
    retryable: true,
  };
}

/**
 * Calls `POST /api/delivery-evidence/visual-review/run` and returns the
 * frozen `VisualReviewRunResponse` union. Never throws: transport, parse,
 * and schema failures are all mapped into the failure branch so callers can
 * apply the plan's unavailable-renderer circuit breaker uniformly.
 */
export async function invokeVisualReview(
  input: InvokeVisualReviewInput,
  options: InvokeVisualReviewOptions = {},
): Promise<VisualReviewRunResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const request: VisualReviewRunRequest = {
    schemaVersion: 'devflow.visual-review.run.request/v1alpha1',
    ...input,
  };

  let response: Response;
  try {
    response = await fetchImpl(resolveEndpoint(VISUAL_REVIEW_RUN_ENDPOINT, options.apiBase), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
  } catch {
    return rendererUnavailable('Visual Review endpoint unreachable');
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return runnerFailed('Visual Review returned a non-JSON response');
  }

  if (!response.ok) {
    const message = typeof (payload as { error?: unknown })?.error === 'string'
      ? (payload as { error: string }).error
      : 'Visual Review request rejected';
    return {
      success: false,
      code: response.status >= 500 ? 'DELIVERY_EVIDENCE_RUNNER_FAILED' : 'DELIVERY_EVIDENCE_INVALID_REQUEST',
      error: message,
      retryable: response.status >= 500,
    };
  }

  try {
    return parseVisualReviewRunResponse(payload);
  } catch {
    return runnerFailed('Visual Review response did not satisfy the frozen contract');
  }
}

type FailureResponse = Extract<VisualReviewRunResponse, { success: false }>;

export type VisualReviewAttempt =
  | { kind: 'success'; response: Extract<VisualReviewRunResponse, { success: true }> }
  | { kind: 'renderer_unavailable'; response: FailureResponse }
  | { kind: 'circuit_open'; reasonCode: 'visual_verification_pending'; postHocReviewRequired: true; error: string }
  | { kind: 'failed'; response: FailureResponse };

/**
 * Calls `invokeVisualReview` and classifies the result for the plan's
 * unavailable-renderer circuit breaker. The 30-minute outage window is
 * owned durably by the runner (T2.7) — this function has no threshold, no
 * clock, and no caller-supplied timestamp of its own; it only maps the
 * server's own response code, so there is exactly one authority for "has
 * this outage gone on long enough."
 */
export async function invokeVisualReviewWithCircuitBreaker(
  input: InvokeVisualReviewInput,
  options: InvokeVisualReviewOptions = {},
): Promise<VisualReviewAttempt> {
  const response = await invokeVisualReview(input, options);
  if (response.success) return { kind: 'success', response };

  const failure: FailureResponse = response;
  if (failure.code === 'DELIVERY_EVIDENCE_VISUAL_VERIFICATION_PENDING') {
    return {
      kind: 'circuit_open',
      reasonCode: failure.reasonCode,
      postHocReviewRequired: failure.postHocReviewRequired,
      error: failure.error,
    };
  }
  if (failure.code === 'DELIVERY_EVIDENCE_RENDERER_UNAVAILABLE') {
    return { kind: 'renderer_unavailable', response: failure };
  }
  return { kind: 'failed', response: failure };
}

/**
 * Maps a stored artifact's `delivery-evidence://` URI to the HTTP path that
 * actually serves its bytes. Returns null for anything that doesn't match
 * the frozen `delivery-evidence://<projectId>/<receiptId>/<file>` shape.
 */
export function resolveArtifactUrl(artifact: Pick<EvidenceArtifact, 'uri'>): string | null {
  const match = ARTIFACT_URI_PATTERN.exec(artifact.uri);
  if (!match) return null;
  const [, projectId, receiptId, file] = match;
  const params = new URLSearchParams({ projectId, receiptId, file });
  return `${ARTIFACT_ENDPOINT}?${params.toString()}`;
}

export interface ContactSheetScreenshot {
  artifactId: string;
  route: string;
  viewport: { id: string; width: number; height: number };
  fullPage: boolean;
  url: string | null;
}

/** Joins a run's screenshot list with the receipt's artifact records so the
 * contact sheet can render thumbnails without re-deriving the URI scheme. */
export function buildContactSheetScreenshots(
  result: Pick<VisualReviewRunResult, 'screenshots'>,
  receipt: Pick<DeliveryEvidenceReceipt, 'artifacts'>,
): ContactSheetScreenshot[] {
  const artifactsById = new Map(receipt.artifacts.map((artifact) => [artifact.id, artifact]));
  return result.screenshots.map((screenshot) => {
    const artifact = artifactsById.get(screenshot.artifactId);
    return {
      ...screenshot,
      url: artifact ? resolveArtifactUrl(artifact) : null,
    };
  });
}

export interface DecisionDescription {
  label: string;
  tone: 'success' | 'warning' | 'danger';
}

/** Pure label/tone mapping for `EvidenceDecision.kind`, shared by the
 * contact sheet and any future summary surface so the mapping lives once. */
export function describeDecision(decision: EvidenceDecision): DecisionDescription {
  switch (decision.kind) {
    case 'deliver':
      return { label: 'Deliver', tone: 'success' };
    case 'revise':
      return { label: 'Revise', tone: 'warning' };
    case 'disclose':
      return { label: 'Disclose', tone: 'danger' };
  }
}

const TONE_COLOR: Record<DecisionDescription['tone'], string> = {
  success: 'var(--df-success, #22c55e)',
  warning: 'var(--df-warning, #eab308)',
  danger: 'var(--df-error, #ef4444)',
};

const SEVERITY_COLOR: Record<EvidenceSeverity, string> = {
  p0: 'var(--df-error, #ef4444)',
  p1: '#fb923c',
  p2: 'var(--df-warning, #eab308)',
  p3: 'var(--df-accent, #3b82f6)',
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Renders a compact "optional evidence panel" for a Visual Review response,
 * suitable for pasting directly into an ` ```html ` fenced collab message
 * (see channel-communication.md#rich-content-blocks). Every rule is an
 * inline `style` attribute — AgentChat's html-block sanitizer strips
 * `<style>` tags and doesn't load the app stylesheet in that context, so a
 * class-based render (like `ContactSheet.tsx`) would come out unstyled here.
 * `var(--df-*, fallback)` tokens still resolve because the block renders
 * inline in the live page DOM, with a literal fallback for anywhere that
 * isn't true (e.g. a copy-pasted snippet).
 */
export function renderContactSheetHtmlBlock(response: VisualReviewRunResponse): string {
  const card = 'background:#0a0a0e;border:1px solid rgba(255,255,255,0.1);border-radius:8px;'
    + 'padding:12px 14px;font-family:ui-sans-serif,system-ui,sans-serif;color:#e4e4e7;max-width:480px;';

  if (!response.success) {
    return (
      `<div style="${card}">`
      + '<div style="font-size:11px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;'
      + 'color:rgba(255,255,255,0.55);margin-bottom:8px;">Visual Review</div>'
      + `<div style="color:${TONE_COLOR.warning};font-weight:600;font-size:13px;">`
      + 'implementation ready; visual verification pending</div>'
      + `<div style="font-size:12px;color:#a1a1aa;margin-top:3px;">${escapeHtml(response.error)} `
      + `<code style="font-size:11px;color:#71717a;">${escapeHtml(response.code)}</code></div>`
      + '</div>'
    );
  }

  const { receipt, result } = response;
  const decision = describeDecision(receipt.decision);
  const screenshots = buildContactSheetScreenshots(result, receipt).slice(0, 3);
  const findings = [...receipt.findings].sort(
    (a, b) => Number(a.severity.slice(1)) - Number(b.severity.slice(1)),
  );
  const topFindings = findings.slice(0, 3);

  const thumbs = screenshots.length === 0 ? '' : (
    '<div style="display:flex;gap:6px;margin:8px 0;">'
    + screenshots.map((shot) => (shot.url
      ? `<img src="${escapeHtml(shot.url)}" alt="${escapeHtml(shot.route)} — ${escapeHtml(shot.viewport.id)}" `
        + 'style="width:72px;height:56px;object-fit:cover;object-position:top;border-radius:4px;'
        + 'border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.3);" />'
      : '')).join('')
    + '</div>'
  );

  const findingsList = topFindings.length === 0 ? (
    `<div style="font-size:12px;color:${TONE_COLOR.success};margin-top:6px;">No findings — clean.</div>`
  ) : (
    '<div style="margin-top:6px;">'
    + topFindings.map((finding) => (
      '<div style="font-size:11.5px;color:#d4d4d8;padding:2px 0;">'
      + `<span style="color:${SEVERITY_COLOR[finding.severity]};font-weight:700;">`
      + `${finding.severity.toUpperCase()}</span> ${escapeHtml(finding.summary)}</div>`
    )).join('')
    + (findings.length > topFindings.length
      ? `<div style="font-size:11px;color:#71717a;margin-top:2px;">+${findings.length - topFindings.length} more</div>`
      : '')
    + '</div>'
  );

  return (
    `<div style="${card}">`
    + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">'
    + '<span style="font-size:11px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;'
    + 'color:rgba(255,255,255,0.55);">Visual Review</span>'
    + `<span style="font-size:10px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;`
    + `padding:2px 8px;border-radius:2px;background:${TONE_COLOR[decision.tone]}22;`
    + `color:${TONE_COLOR[decision.tone]};">${decision.label}</span>`
    + '</div>'
    + thumbs
    + findingsList
    + `<div style="font-size:10px;color:#52525b;margin-top:8px;">receipt ${escapeHtml(receipt.id)}</div>`
    + '</div>'
  );
}
