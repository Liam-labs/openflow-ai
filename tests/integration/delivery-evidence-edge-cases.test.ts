import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http, { type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ContactSheet } from '@/components/delivery-evidence/ContactSheet';
import {
  computeVisualReviewSourceFingerprint,
  createVisualReviewRunner,
  type VisualReviewAdapterDependencies,
} from '@/lib/delivery-evidence/adapters/visual-review';
import {
  headlessReviewCapture,
  startHeadlessSession,
  stopHeadlessSession,
  type HeadlessReviewCaptureOptions,
  type HeadlessReviewCaptureResult,
} from '@/lib/computer-use-headless';
import { buildContactSheetScreenshots, describeDecision } from '@/lib/delivery-evidence/skill';
import { createDeliveryEvidenceStore } from '@/lib/delivery-evidence/store';
import type { VisualReviewRunRequest } from '@/lib/delivery-evidence/types';

/**
 * Real end-to-end coverage for T2.3: a genuine local project (temp dir +
 * real `.devflow/delivery-evidence.yaml`), a real HTTP preview server, and
 * the real registered runner — store, adapter, and headless Playwright
 * capture are NOT mocked. Only `getProjectById` is swapped so the run never
 * touches DevFlow's own registry, and the receipt/artifact store root is a
 * throwaway temp directory so nothing lands in the shared `.AppData` tree.
 */

const PROJECT_ID = 'edge-case-fixture-project';
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

let previewServer: Server;
let previewPort: number;
let projectDir: string;
let artifactsRootDir: string;
let store: ReturnType<typeof createDeliveryEvidenceStore>;
let deps: VisualReviewAdapterDependencies;
let captureSpy: ReturnType<
  typeof vi.fn<(sessionId: string, options: HeadlessReviewCaptureOptions) => Promise<HeadlessReviewCaptureResult>>
>;

function html(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>fixture</title></head><body>${body}</body></html>`;
}

function noiseCanvasPage(): string {
  // A ~2600x2300 canvas of cryptographically random per-pixel noise. PNG's
  // DEFLATE filter barely compresses true random noise, so the full-page
  // screenshot of this route reliably exceeds the registered 10MB
  // maxArtifactBytes limit while the (viewport-cropped) non-fullPage shot
  // stays comfortably under it — isolating the fullPage overflow path.
  return html(`
    <style>html,body{margin:0;padding:0;}canvas{display:block;}</style>
    <canvas id="c" width="2600" height="2300"></canvas>
    <script>
      const c = document.getElementById('c');
      const ctx = c.getContext('2d');
      const img = ctx.createImageData(c.width, c.height);
      // crypto.getRandomValues has a 65536-byte quota per call — fill in chunks.
      for (let offset = 0; offset < img.data.length; offset += 65536) {
        crypto.getRandomValues(img.data.subarray(offset, Math.min(offset + 65536, img.data.length)));
      }
      for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255; // opaque
      ctx.putImageData(img, 0, 0);
    </script>
  `);
}

function crashPage(): string {
  return html(`
    <h1>Fixture — simulated crash</h1>
    <script>
      try {
        JSON.parse('not json');
      } catch (err) {
        console.error('Simulated crash on load: ' + err.message);
      }
    </script>
  `);
}

async function waitUntilReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`preview never became ready: ${String(lastError)}`);
}

function baseRequest(overrides: Partial<VisualReviewRunRequest> = {}): VisualReviewRunRequest {
  return {
    schemaVersion: 'devflow.visual-review.run.request/v1alpha1',
    taskId: `task-${randomUUID()}`,
    projectId: PROJECT_ID,
    projectPath: projectDir,
    contractId: 'contract-visual-pilot',
    contractFingerprint: 'a'.repeat(64),
    verificationProfileVersion: '1.0.0',
    checkpoint: 'final',
    changedPaths: ['component.tsx'],
    routes: ['/'],
    viewports: [{ id: 'desktop', width: 1280, height: 800 }],
    fixtureProfile: 'safe-demo',
    ...overrides,
  };
}

beforeAll(async () => {
  previewServer = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
      return;
    }
    if (url === '/crash') {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(crashPage());
      return;
    }
    if (url === '/huge') {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(noiseCanvasPage());
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(html('<h1>Fixture project home</h1><p>Nothing to see here.</p>'));
  });
  await new Promise<void>((resolve) => previewServer.listen(0, '127.0.0.1', resolve));
  previewPort = (previewServer.address() as { port: number }).port;

  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-evidence-project-'));
  artifactsRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-evidence-artifacts-'));
  await fs.writeFile(path.join(projectDir, 'component.tsx'), 'export const Fixture = () => null;\n', 'utf8');
  await fs.mkdir(path.join(projectDir, '.devflow'), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, '.devflow', 'delivery-evidence.yaml'),
    `schemaVersion: devflow.delivery-evidence.profile/v1alpha1
profile:
  id: edge-case-fixture
  version: 1.0.0
project:
  id: ${PROJECT_ID}
  root: .
preview:
  baseUrl: http://127.0.0.1:${previewPort}
  readiness:
    path: /health
    timeoutMs: 15000
  routes:
    - /
    - /crash
    - /huge
  viewports:
    - id: desktop
      width: 1280
      height: 800
fixtures:
  default: safe-demo
  profiles:
    - id: safe-demo
checks:
  visual-review:
    runnerId: playwright.visual-review
    runnerVersion: 1.0.0
    enabled: true
riskRules: []
policy:
  mode: advisory
  maxRevisionPasses: 2
  rendererUnavailableAfterMs: 1800000
`,
    'utf8',
  );
  await waitUntilReady(`http://127.0.0.1:${previewPort}/health`, 5_000);

  store = createDeliveryEvidenceStore({
    rootDir: artifactsRootDir,
    getProjectById: async (id) => (id === PROJECT_ID ? { id: PROJECT_ID, path: projectDir } : undefined),
  });

  // Real Chromium exhibits a well-documented cold-start flake: the FIRST
  // `page.screenshot()` on a freshly created context can throw
  // "Protocol error (Page.captureScreenshot): Unable to capture screenshot"
  // even though the page loaded successfully; an immediate retry on the same
  // page succeeds (confirmed by direct repro against this exact environment
  // — see the T2.3 completion report). This is a known Playwright/CDP
  // renderer-not-yet-ready race, not an adapter or test bug, so the fixture
  // retries the real capture once rather than papering over it with a mock.
  async function resilientCapture(
    sessionId: string,
    options: Parameters<typeof headlessReviewCapture>[1],
  ) {
    try {
      return await headlessReviewCapture(sessionId, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('Unable to capture screenshot')) throw error;
      return headlessReviewCapture(sessionId, options);
    }
  }
  captureSpy = vi.fn(resilientCapture);
  deps = {
    store,
    waitForReadiness: (baseUrl, readiness) =>
      waitUntilReady(new URL(readiness.path, baseUrl).toString(), readiness.timeoutMs),
    startHeadlessSession,
    stopHeadlessSession,
    capture: captureSpy,
    computeSourceFingerprint: computeVisualReviewSourceFingerprint,
    now: () => new Date().toISOString(),
    createId: (prefix) => `${prefix}-${randomUUID()}`,
  };
}, 30_000);

afterAll(async () => {
  await new Promise((resolve) => previewServer.close(resolve));
  await fs.rm(projectDir, { recursive: true, force: true });
  await fs.rm(artifactsRootDir, { recursive: true, force: true });
});

describe('Delivery Evidence — real end-to-end run against a local fixture project', () => {
  it(
    'invokes visual-review.run against a real local project, persists the receipt, and renders a contact sheet from it',
    async () => {
      const response = await createVisualReviewRunner(deps)(baseRequest());

      expect(response.success).toBe(true);
      if (!response.success) throw new Error(response.error);

      // Genuine capture, not a stub: real PNG bytes for both the viewport
      // and full-page screenshots.
      expect(response.result.screenshots).toHaveLength(2);
      for (const screenshot of response.result.screenshots) {
        const artifact = response.receipt.artifacts.find((a) => a.id === screenshot.artifactId);
        expect(artifact).toBeDefined();
        const stored = await store.readArtifact({
          projectId: PROJECT_ID,
          receiptId: response.receipt.id,
          fileName: `${screenshot.artifactId}.png`,
        });
        expect(stored.data.subarray(0, 4)).toEqual(PNG_MAGIC);
      }

      // The receipt is genuinely persisted, not just returned in-memory.
      const reread = await store.readReceipt(PROJECT_ID, response.receipt.id);
      expect(reread.id).toBe(response.receipt.id);

      // Clean fixture page, but this receipt's review.mode is
      // 'deterministic_only' (no human/agent actually looked at the
      // screenshots) — per T2.5's fix, that must always disclose, never
      // silently claim deliver, regardless of finding count.
      expect(response.receipt.review.mode).toBe('deterministic_only');
      expect(response.receipt.review.reviewedArtifactIds).toEqual([]);
      expect(response.receipt.decision).toEqual(
        expect.objectContaining({ kind: 'disclose', reasonCode: 'visual_review_pending' }),
      );

      // Full loop: real evidence renders through the same skill helpers and
      // component the frontend agent uses to report the task.
      const screenshots = buildContactSheetScreenshots(response.result, response.receipt);
      expect(screenshots.every((s) => s.url?.startsWith('/api/delivery-evidence/artifact?'))).toBe(true);
      expect(describeDecision(response.receipt.decision)).toEqual({ label: 'Disclose', tone: 'danger' });
      const markup = renderToStaticMarkup(React.createElement(ContactSheet, { response }));
      expect(markup).toContain('dvc-decision--danger');
      expect(markup).toContain('>Disclose<');
    },
    30_000,
  );

  it(
    'edge case: an empty diff (no changed paths) still produces a valid, deterministic receipt',
    async () => {
      const request = baseRequest({ changedPaths: [] });
      const response = await createVisualReviewRunner(deps)(request);

      expect(response.success).toBe(true);
      if (!response.success) throw new Error(response.error);
      expect(response.receipt.source.changedPaths).toEqual([]);

      // Fingerprinting an empty diff is deterministic — same input, same
      // fingerprint, computed independently of this run.
      const fingerprintAgain = await computeVisualReviewSourceFingerprint(projectDir, []);
      expect(response.receipt.source.fingerprint).toBe(fingerprintAgain);
    },
    30_000,
  );

  it(
    'edge case: a page that crashes on load is disclosed as a finding, not looped or retried',
    async () => {
      const callsBefore = captureSpy.mock.calls.length;
      const response = await createVisualReviewRunner(deps)(baseRequest({ routes: ['/crash'] }));

      expect(response.success).toBe(true);
      if (!response.success) throw new Error(response.error);

      // Exactly one capture per screenshot kind for this route/viewport —
      // proves the runner disclosed the failure instead of retry-looping.
      expect(captureSpy.mock.calls.length - callsBefore).toBe(2);

      expect(response.result.consoleErrors).toEqual([
        expect.objectContaining({ route: '/crash', message: expect.stringContaining('Simulated crash on load') }),
      ]);
      expect(response.receipt.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'browser_console_error', severity: 'p1', status: 'unresolved' }),
        ]),
      );
      expect(response.receipt.decision).toEqual(
        expect.objectContaining({ kind: 'disclose', reasonCode: 'pilot_advisory_findings' }),
      );
    },
    30_000,
  );

  it(
    'edge case: two agents reviewing the same project concurrently get independent receipts',
    async () => {
      const [responseA, responseB] = await Promise.all([
        createVisualReviewRunner(deps)(baseRequest({ taskId: 'task-concurrent-a' })),
        createVisualReviewRunner(deps)(baseRequest({ taskId: 'task-concurrent-b' })),
      ]);

      expect(responseA.success).toBe(true);
      expect(responseB.success).toBe(true);
      if (!responseA.success || !responseB.success) throw new Error('concurrent run failed');

      expect(responseA.receipt.id).not.toBe(responseB.receipt.id);
      expect(responseA.receipt.taskId).toBe('task-concurrent-a');
      expect(responseB.receipt.taskId).toBe('task-concurrent-b');
      // No artifact-id collisions between the two independent runs.
      const idsA = new Set(responseA.receipt.artifacts.map((a) => a.id));
      const idsB = responseB.receipt.artifacts.map((a) => a.id);
      expect(idsB.some((id) => idsA.has(id))).toBe(false);

      // Both receipts are independently readable back from the store.
      const rereadA = await store.readReceipt(PROJECT_ID, responseA.receipt.id);
      const rereadB = await store.readReceipt(PROJECT_ID, responseB.receipt.id);
      expect(rereadA.taskId).toBe('task-concurrent-a');
      expect(rereadB.taskId).toBe('task-concurrent-b');
    },
    45_000,
  );

  it(
    'edge case: a full-page screenshot over the 10MB artifact limit is omitted and disclosed, not failed',
    async () => {
      // Fixed by Builder in lib/delivery-evidence/adapters/visual-review.ts
      // (~line 414-435): COMPUTER_USE_HEADLESS_ARTIFACT_TOO_LARGE from the
      // full-page capture is now caught specifically — the valid viewport
      // screenshot is kept, the oversized full-page artifact is omitted, and
      // an objective P2 `full_page_screenshot_truncated` finding is recorded
      // instead of failing the whole run. Verified here against a real
      // >10MB PNG (a 2600x2300 random-noise canvas, genuinely incompressible),
      // not a synthetic size flag.
      const response = await createVisualReviewRunner(deps)(baseRequest({ routes: ['/huge'] }));

      expect(response.success).toBe(true);
      if (!response.success) throw new Error(response.error);

      // Viewport screenshot kept; oversized full-page screenshot omitted.
      expect(response.result.screenshots).toEqual([expect.objectContaining({ fullPage: false })]);
      expect(response.receipt.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'full_page_screenshot_truncated',
            severity: 'p2',
            status: 'unresolved',
            objective: true,
          }),
        ]),
      );
      expect(response.receipt.decision).toEqual(
        expect.objectContaining({ kind: 'disclose', reasonCode: 'pilot_advisory_findings' }),
      );

      // The receipt is genuinely persisted despite the partial capture.
      const reread = await store.readReceipt(PROJECT_ID, response.receipt.id);
      expect(reread.id).toBe(response.receipt.id);

      // Both the viewport and the (attempted, then omitted) full-page
      // captures were genuinely invoked for this route — proves the
      // omission is specific to the oversized fullPage call, not a
      // route/profile-level skip. (mock.results[i].type only reflects the
      // synchronous return of the promise for an async mock, not whether it
      // later rejects, so call count is the reliable signal here.)
      const callsBeforeThisRoute = captureSpy.mock.calls.length - 2;
      expect(
        captureSpy.mock.calls.slice(callsBeforeThisRoute).map((call) => call[1].fullPage),
      ).toEqual([false, true]);
    },
    30_000,
  );
});
