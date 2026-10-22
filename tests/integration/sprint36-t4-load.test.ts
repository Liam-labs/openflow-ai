/**
 * Sprint 36 T4 — 5 simultaneous live streams soak test.
 *
 * Spins up 5 concurrent SSE clients against the real /api/agent-stream route
 * handler, each pointed at a different JSONL fixture. Measures:
 *   (a) event latency from append() call to client receipt
 *   (b) server process RSS + heap delta over the soak window
 *   (c) rotation handling — swap one resolver output mid-stream
 *   (d) disconnect cleanup — abort one client mid-stream
 *
 * Soak time is configurable via SPRINT36_T4_SOAK_MS — default 60 seconds for
 * CI/local runs. Pass 600000 (10 min) for the gating run.
 *
 *   SPRINT36_T4_SOAK_MS=600000 npx vitest run tests/integration/sprint36-t4-load.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { resolveJsonlForDirMock, findAgentByNameMock } = vi.hoisted(() => ({
  resolveJsonlForDirMock: vi.fn(),
  findAgentByNameMock: vi.fn(async (name: string) => ({
    id: `agent-id-${name}`,
    name,
    workingDirectory: `/tmp/${name}`,
    channelId: 'ch-test',
    agentType: 'claude',
  })),
}));

vi.mock('@/lib/agent-jsonl-resolver', () => ({
  resolveJsonlForDir: resolveJsonlForDirMock,
  findAgentByName: findAgentByNameMock,
}));

import { GET } from '@/app/api/agent-stream/route';
import {
  __resetActiveStreamsForTest,
  __getActiveStreamsForTest,
} from '@/lib/agent-stream-state';

const SOAK_MS = Number(process.env.SPRINT36_T4_SOAK_MS ?? 60_000);
const STREAM_COUNT = 5;
const APPEND_INTERVAL_MS = 250; // each agent emits an event every 250ms
const POLL_INTERVAL_MS = 500; // must match route's POLL_INTERVAL_MS
const LATENCY_BUDGET_MS = 2_000; // p95 latency budget
const ROTATION_AT_MS = Math.floor(SOAK_MS * 0.4);
const DISCONNECT_AT_MS = Math.floor(SOAK_MS * 0.6);
const MEMORY_GROWTH_BUDGET_BYTES = 64 * 1024 * 1024; // 64 MB over soak

interface LatencySample {
  stream: number;
  appendedAt: number;
  receivedAt: number;
  latencyMs: number;
}

interface StreamResult {
  stream: number;
  agentName: string;
  eventsReceived: number;
  rotatedEvents: number;
  heartbeats: number;
  errors: number;
  closedEarly: boolean;
  latencies: LatencySample[];
}

function makeReq(agent: string, signal: AbortSignal): NextRequest {
  const url = `http://localhost:3000/api/agent-stream?agent=${encodeURIComponent(agent)}`;
  return new NextRequest(url, { method: 'GET', signal });
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

interface SseEvent {
  event: string;
  data: unknown;
  id?: string;
}

/**
 * Async SSE reader that yields parsed events as they arrive. Tracks the
 * wall-clock time when each event is received so the caller can measure
 * latency against the append timestamp embedded in the JSONL line.
 */
async function readStreamUntil(
  res: Response,
  onEvent: (e: SseEvent, receivedAt: number) => void,
  abortSignal: AbortSignal,
): Promise<void> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  // Single abort promise for the whole read loop — avoids leaking a fresh
  // listener per iteration. This surfaced as a MaxListenersExceededWarning
  // when the original version added a listener each poll cycle.
  let abortResolve!: () => void;
  const abortPromise: Promise<{ done: true; value?: undefined }> = new Promise((resolve) => {
    const finish = () => resolve({ done: true });
    abortResolve = finish;
    if (abortSignal.aborted) finish();
    else abortSignal.addEventListener('abort', finish, { once: true });
  });
  try {
    while (!abortSignal.aborted) {
      const readPromise = reader.read();
      const { done, value } = (await Promise.race([readPromise, abortPromise])) as {
        done: boolean;
        value?: Uint8Array;
      };
      if (done) break;
      if (!value) continue;
      const receivedAt = Date.now();
      buf += decoder.decode(value, { stream: true });
      // Drain complete \n\n-delimited blocks
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (!block.trim()) continue;
        let event = 'message';
        let data: string = '';
        let id: string | undefined;
        for (const line of block.split('\n')) {
          if (line.startsWith('id: ')) id = line.slice(4);
          else if (line.startsWith('event: ')) event = line.slice(7);
          else if (line.startsWith('data: ')) data = line.slice(6);
        }
        let parsed: unknown = data;
        try {
          parsed = JSON.parse(data);
        } catch {
          /* leave as string */
        }
        onEvent({ event, data: parsed, id }, receivedAt);
      }
    }
  } finally {
    try {
      abortResolve();
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
}

describe('Sprint 36 T4 — 5 simultaneous live streams', () => {
  let sandbox: string;
  const jsonlPaths: string[] = [];
  const rotatedJsonlPath = '';

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'sprint36-t4-'));
    __resetActiveStreamsForTest();
    resolveJsonlForDirMock.mockReset();
    jsonlPaths.length = 0;
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
    __resetActiveStreamsForTest();
  });

  it(
    `${STREAM_COUNT} concurrent streams survive a ${SOAK_MS / 1000}s soak with rotation + disconnect`,
    async () => {
      // ── fixtures ──────────────────────────────────────────────────────────
      for (let i = 0; i < STREAM_COUNT; i++) {
        const p = join(sandbox, `agent${i}.jsonl`);
        writeFileSync(p, ''); // empty starting file
        jsonlPaths.push(p);
      }
      const rotatedPath = join(sandbox, `agent0-rotated.jsonl`);
      writeFileSync(rotatedPath, '');

      // Resolver: per agent name → jsonl path. Stream 0 will be rotated later.
      const pathByAgent: Record<string, string> = {};
      for (let i = 0; i < STREAM_COUNT; i++) {
        pathByAgent[`Agent${i}`] = jsonlPaths[i];
      }
      resolveJsonlForDirMock.mockImplementation(async (agentDir: string) => {
        const agent = agentDir.split('/').filter(Boolean).at(-1) ?? '';
        const p = pathByAgent[agent];
        if (!p) return null;
        return { path: p, resolvedVia: 'primary-a-transcript-path' as const };
      });

      // ── kick off 5 concurrent streams ─────────────────────────────────────
      const results: StreamResult[] = [];
      const aborts: AbortController[] = [];
      const readerTasks: Array<Promise<void>> = [];

      for (let i = 0; i < STREAM_COUNT; i++) {
        const result: StreamResult = {
          stream: i,
          agentName: `Agent${i}`,
          eventsReceived: 0,
          rotatedEvents: 0,
          heartbeats: 0,
          errors: 0,
          closedEarly: false,
          latencies: [],
        };
        results.push(result);
        const ac = new AbortController();
        aborts.push(ac);
        const req = makeReq(result.agentName, ac.signal);
        const res = await GET(req);
        expect(res.status).toBe(200);
        readerTasks.push(
          readStreamUntil(
            res as Response,
            (e, receivedAt) => {
              if (e.event === 'message') {
                result.eventsReceived++;
                const d = e.data as { appendedAt?: number };
                if (d && typeof d.appendedAt === 'number') {
                  result.latencies.push({
                    stream: i,
                    appendedAt: d.appendedAt,
                    receivedAt,
                    latencyMs: receivedAt - d.appendedAt,
                  });
                }
              } else if (e.event === 'heartbeat') result.heartbeats++;
              else if (e.event === 'rotated') result.rotatedEvents++;
              else if (e.event === 'error') result.errors++;
            },
            ac.signal,
          ).catch(() => {
            result.closedEarly = true;
          }),
        );
      }

      expect(__getActiveStreamsForTest()).toBe(STREAM_COUNT);

      // ── soak loop: append to each jsonl every 250ms ───────────────────────
      const memSamples: { tMs: number; rss: number; heap: number; external: number }[] = [];
      const memStart = process.memoryUsage();
      memSamples.push({ tMs: 0, rss: memStart.rss, heap: memStart.heapUsed, external: memStart.external });

      const startTime = Date.now();
      let rotationTriggered = false;
      let disconnectTriggered = false;

      await new Promise<void>((resolve) => {
        const appendTimer = setInterval(() => {
          const now = Date.now();
          const elapsed = now - startTime;
          for (let i = 0; i < STREAM_COUNT; i++) {
            // Skip stream that was disconnected
            if (aborts[i].signal.aborted) continue;
            const payload = JSON.stringify({
              type: 'assistant',
              message: { role: 'assistant', content: [{ type: 'text', text: `hi from ${i}` }] },
              appendedAt: now,
              seq: results[i].eventsReceived,
            });
            // Decide which file to write for stream 0 post-rotation
            const target = i === 0 && rotationTriggered ? rotatedPath : jsonlPaths[i];
            appendFileSync(target, payload + '\n');
          }

          // sample memory every 5s
          if (elapsed % 5_000 < APPEND_INTERVAL_MS) {
            const m = process.memoryUsage();
            memSamples.push({ tMs: elapsed, rss: m.rss, heap: m.heapUsed, external: m.external });
          }

          // Rotation trigger: point resolver for Agent0 at rotatedPath
          if (!rotationTriggered && elapsed >= ROTATION_AT_MS) {
            rotationTriggered = true;
            pathByAgent['Agent0'] = rotatedPath;
          }

          // Disconnect trigger: abort stream #4
          if (!disconnectTriggered && elapsed >= DISCONNECT_AT_MS) {
            disconnectTriggered = true;
            aborts[4].abort();
          }

          if (elapsed >= SOAK_MS) {
            clearInterval(appendTimer);
            resolve();
          }
        }, APPEND_INTERVAL_MS);
      });

      // ── tear down remaining streams ───────────────────────────────────────
      for (let i = 0; i < STREAM_COUNT; i++) {
        if (!aborts[i].signal.aborted) aborts[i].abort();
      }

      // Wait for all reader tasks to finish cleanly
      await Promise.all(readerTasks);

      const memEnd = process.memoryUsage();
      memSamples.push({ tMs: Date.now() - startTime, rss: memEnd.rss, heap: memEnd.heapUsed, external: memEnd.external });

      // ── assertions ───────────────────────────────────────────────────────
      // (A) all streams produced events
      for (const r of results) {
        if (r.stream === 4) continue; // disconnected mid-stream, expected short
        expect(r.eventsReceived, `stream ${r.stream} should receive events`).toBeGreaterThan(
          0,
        );
      }

      // (B) cleanup counter decrements to zero
      expect(__getActiveStreamsForTest(), 'all streams cleaned up').toBe(0);

      // (C) p95 latency budget
      const allLatencies = results
        .flatMap((r) => r.latencies.map((s) => s.latencyMs))
        .sort((a, b) => a - b);
      const p50 = percentile(allLatencies, 50);
      const p95 = percentile(allLatencies, 95);
      const p99 = percentile(allLatencies, 99);
      const maxLat = allLatencies.length ? allLatencies[allLatencies.length - 1] : 0;

      // (D) memory growth budget
      const rssGrowth = memEnd.rss - memStart.rss;
      const heapGrowth = memEnd.heapUsed - memStart.heapUsed;

      // (E) rotation was observed on stream 0
      const stream0 = results[0];
      // (F) disconnected stream 4 ended cleanly
      const stream4 = results[4];

      // ── report ───────────────────────────────────────────────────────────
      const report = {
        soakSeconds: SOAK_MS / 1000,
        streamCount: STREAM_COUNT,
        appendIntervalMs: APPEND_INTERVAL_MS,
        pollIntervalMs: POLL_INTERVAL_MS,
        latencyBudgetMs: LATENCY_BUDGET_MS,
        memoryBudgetBytes: MEMORY_GROWTH_BUDGET_BYTES,
        latency: {
          samples: allLatencies.length,
          p50,
          p95,
          p99,
          max: maxLat,
        },
        memory: {
          rssStart: memStart.rss,
          rssEnd: memEnd.rss,
          rssGrowth,
          heapStart: memStart.heapUsed,
          heapEnd: memEnd.heapUsed,
          heapGrowth,
          samples: memSamples.length,
        },
        rotation: {
          triggered: rotationTriggered,
          rotatedEventsReceived: stream0.rotatedEvents,
        },
        disconnect: {
          triggered: disconnectTriggered,
          stream4Events: stream4.eventsReceived,
          stream4ClosedEarly: stream4.closedEarly,
          activeStreamsAfterTeardown: __getActiveStreamsForTest(),
        },
        perStream: results.map((r) => ({
          stream: r.stream,
          events: r.eventsReceived,
          heartbeats: r.heartbeats,
          rotated: r.rotatedEvents,
          errors: r.errors,
          latencySamples: r.latencies.length,
          closedEarly: r.closedEarly,
        })),
      };
      console.log('\n=== Sprint 36 T4 — Load Test Report ===');
      console.log(JSON.stringify(report, null, 2));

      // Write JSON report to disk for Jack's review
      const reportPath = join(
        '/home/user/SG-1/Team/Architect/research/sprint-36',
        `t4-load-report-${SOAK_MS / 1000}s.json`,
      );
      try {
        const { mkdirSync } = await import('node:fs');
        mkdirSync(join('/home/user/SG-1/Team/Architect/research/sprint-36'), {
          recursive: true,
        });
        writeFileSync(reportPath, JSON.stringify(report, null, 2));
        console.log(`\nReport written: ${reportPath}`);
      } catch (err) {
        console.warn('could not write report file:', err);
      }

      // Hard gating assertions
      expect(p95, `p95 latency should be under ${LATENCY_BUDGET_MS}ms`).toBeLessThan(
        LATENCY_BUDGET_MS,
      );
      expect(
        rssGrowth,
        `RSS growth ${rssGrowth}B should be under budget ${MEMORY_GROWTH_BUDGET_BYTES}B`,
      ).toBeLessThan(MEMORY_GROWTH_BUDGET_BYTES);
      expect(stream0.rotatedEvents, 'rotation event should arrive on stream 0').toBeGreaterThanOrEqual(
        1,
      );
    },
    // vitest test timeout = soak + 30s buffer
    SOAK_MS + 30_000,
  );
});
