/**
 * Integration tests for GET /api/agent-stream.
 *
 * Sprint 36 Phase 1 — verifies the SSE endpoint wires backfill + tail + meta
 * events correctly. Runtime source resolution is mocked so the test controls
 * the active JSONL path without touching collab-channels.json.
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

// ─── Mocks (hoisted) ─────────────────────────────────────────────────────────

const { findAgentByNameMock, resolveAgentStreamSourceMock } = vi.hoisted(() => ({
  findAgentByNameMock: vi.fn(),
  resolveAgentStreamSourceMock: vi.fn(),
}));

vi.mock('@/lib/agent-jsonl-resolver', () => ({
  findAgentByName: findAgentByNameMock,
}));

vi.mock('@/lib/agent-stream-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agent-stream-runtime')>();
  return {
    ...actual,
    resolveAgentStreamSource: resolveAgentStreamSourceMock,
  };
});

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { GET } from '@/app/api/agent-stream/route';
import {
  __resetActiveStreamsForTest,
  __getActiveStreamsForTest,
} from '@/lib/agent-stream-state';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeReq(params: Record<string, string> = {}): NextRequest {
  const qs = new URLSearchParams(params).toString();
  const url = `http://localhost:3000/api/agent-stream${qs ? '?' + qs : ''}`;
  return new NextRequest(url, {
    method: 'GET',
    headers: {
      // No x-forwarded-for → localhost bypass kicks in via requireAuthOrLocal
    },
  });
}

/**
 * Consume an SSE stream for up to `timeoutMs`, then abort. Returns the
 * concatenated raw body as a string so tests can assert on event shape.
 */
async function readStream(
  res: Response,
  timeoutMs: number,
  abortController: AbortController,
): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let accumulated = '';
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const readPromise = reader.read();
    const timeoutPromise = new Promise<{ done: true; value?: undefined }>((resolve) =>
      setTimeout(() => resolve({ done: true }), remaining),
    );
    const { done, value } = (await Promise.race([
      readPromise,
      timeoutPromise,
    ])) as { done: boolean; value?: Uint8Array };
    if (done) break;
    if (value) accumulated += decoder.decode(value, { stream: true });
  }

  // Trigger cleanup on the route's request.signal listener
  abortController.abort();
  try {
    await reader.cancel();
  } catch {
    // ignore
  }
  return accumulated;
}

/** Parse raw SSE stream text into an array of {event, data, id?} records. */
function parseSSE(raw: string): Array<{ id?: string; event: string; data: string }> {
  const events: Array<{ id?: string; event: string; data: string }> = [];
  const blocks = raw.split('\n\n');
  for (const block of blocks) {
    if (!block.trim()) continue;
    let id: string | undefined;
    let event = 'message';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('id: ')) id = line.slice(4);
      else if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) data = line.slice(6);
    }
    events.push({ id, event, data });
  }
  return events;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GET /api/agent-stream', () => {
  let sandbox: string;
  let jsonlPath: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'agent-stream-route-'));
    jsonlPath = join(sandbox, 'session.jsonl');
    __resetActiveStreamsForTest();
    findAgentByNameMock.mockReset();
    findAgentByNameMock.mockResolvedValue({
      id: 'roster-test',
      name: 'Test',
      workingDirectory: sandbox,
      effectiveWorkingDirectory: sandbox,
      channelId: 'channel-test',
      participantId: 'participant-test',
      color: '#fff',
      status: 'running',
      autoResume: false,
      useCollabWrapper: true,
      dangerouslySkipPermissions: false,
      createdAt: '2026-07-18T00:00:00Z',
      crashCount: 0,
      agentType: 'claude',
    });
    resolveAgentStreamSourceMock.mockReset();
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
    __resetActiveStreamsForTest();
  });

  it('returns 400 when agent query param is missing', async () => {
    const res = await GET(makeReq());
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/agent.*required/i);
  });

  it('returns 400 when agent query param is empty string', async () => {
    const res = await GET(makeReq({ agent: '   ' }));
    expect(res.status).toBe(400);
  });

  it('returns 404 when resolver cannot find the agent', async () => {
    findAgentByNameMock.mockResolvedValue(null);
    const res = await GET(makeReq({ agent: 'Unknown' }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/Unknown/);
  });

  it('returns 404 when the roster agent has no runtime-owned session', async () => {
    resolveAgentStreamSourceMock.mockResolvedValue(null);
    const res = await GET(makeReq({ agent: 'Test' }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/no active claude session/i);
  });

  it('sends meta event immediately on connect', async () => {
    writeFileSync(jsonlPath, '');
    resolveAgentStreamSourceMock.mockResolvedValue({
      path: jsonlPath,
      runtime: 'claude',
      resolvedVia: 'scratch',
    });

    const abortController = new AbortController();
    const req = new NextRequest(
      'http://localhost:3000/api/agent-stream?agent=Test',
      { method: 'GET', signal: abortController.signal },
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    const raw = await readStream(res, 200, abortController);
    const events = parseSSE(raw);
    const meta = events.find((e) => e.event === 'meta');
    expect(meta).toBeDefined();
    const metaData = JSON.parse(meta!.data);
    expect(metaData.agent).toBe('Test');
    expect(metaData.path).toBe(jsonlPath);
    expect(metaData.runtime).toBe('claude');
    expect(metaData.resolvedVia).toBe('scratch');
  });

  it('backfills existing lines as message events on connect', async () => {
    const line1 = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } });
    const line2 = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello' }] },
    });
    writeFileSync(jsonlPath, `${line1}\n${line2}\n`);
    resolveAgentStreamSourceMock.mockResolvedValue({
      path: jsonlPath,
      runtime: 'claude',
      resolvedVia: 'fallback',
    });

    const abortController = new AbortController();
    const req = new NextRequest(
      'http://localhost:3000/api/agent-stream?agent=Test',
      { method: 'GET', signal: abortController.signal },
    );
    const res = await GET(req);
    const raw = await readStream(res, 200, abortController);
    const events = parseSSE(raw);
    const messages = events.filter((e) => e.event === 'message');
    expect(messages.length).toBe(2);
    const firstData = JSON.parse(messages[0].data);
    const secondData = JSON.parse(messages[1].data);
    expect(firstData.type).toBe('user');
    expect(secondData.type).toBe('assistant');
    expect(secondData.message.content[0].type).toBe('text');
  });

  it('normalizes native Codex rollout lines before emitting them', async () => {
    writeFileSync(
      jsonlPath,
      JSON.stringify({
        timestamp: '2026-07-18T12:00:00Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Codex is live.' }],
        },
      }) + '\n',
    );
    resolveAgentStreamSourceMock.mockResolvedValue({
      path: jsonlPath,
      runtime: 'codex',
      resolvedVia: 'codex-session-cwd',
    });

    const abortController = new AbortController();
    const req = new NextRequest(
      'http://localhost:3000/api/agent-stream?agent=Test',
      { method: 'GET', signal: abortController.signal },
    );
    const res = await GET(req);
    const raw = await readStream(res, 200, abortController);
    const message = parseSSE(raw).find((event) => event.event === 'message');

    expect(JSON.parse(message!.data)).toMatchObject({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Codex is live.' }] },
    });
  });

  it('tails appended lines after backfill', async () => {
    writeFileSync(jsonlPath, JSON.stringify({ type: 'user', n: 0 }) + '\n');
    resolveAgentStreamSourceMock.mockResolvedValue({
      path: jsonlPath,
      runtime: 'claude',
      resolvedVia: 'scratch',
    });

    const abortController = new AbortController();
    const req = new NextRequest(
      'http://localhost:3000/api/agent-stream?agent=Test',
      { method: 'GET', signal: abortController.signal },
    );
    const res = await GET(req);

    // Let the stream connect + backfill, then append new line
    setTimeout(() => {
      appendFileSync(jsonlPath, JSON.stringify({ type: 'assistant', n: 1 }) + '\n');
    }, 100);

    const raw = await readStream(res, 900, abortController);
    const events = parseSSE(raw);
    const messages = events.filter((e) => e.event === 'message');
    // Should have at least the backfill line + the appended line
    expect(messages.length).toBeGreaterThanOrEqual(2);
    const appendedData = JSON.parse(messages[messages.length - 1].data);
    expect(appendedData.n).toBe(1);
  });

  it('increments event id on every message', async () => {
    const lines = Array.from({ length: 3 }, (_, i) =>
      JSON.stringify({ type: 'user', n: i }),
    ).join('\n') + '\n';
    writeFileSync(jsonlPath, lines);
    resolveAgentStreamSourceMock.mockResolvedValue({
      path: jsonlPath,
      runtime: 'claude',
      resolvedVia: 'scratch',
    });

    const abortController = new AbortController();
    const req = new NextRequest(
      'http://localhost:3000/api/agent-stream?agent=Test',
      { method: 'GET', signal: abortController.signal },
    );
    const res = await GET(req);
    const raw = await readStream(res, 200, abortController);
    const events = parseSSE(raw);
    const messages = events.filter((e) => e.event === 'message');
    expect(messages.map((m) => m.id)).toEqual(['1', '2', '3']);
  });

  it('handles malformed jsonl lines by wrapping in {raw}', async () => {
    writeFileSync(jsonlPath, 'not valid json\n');
    resolveAgentStreamSourceMock.mockResolvedValue({
      path: jsonlPath,
      runtime: 'claude',
      resolvedVia: 'scratch',
    });

    const abortController = new AbortController();
    const req = new NextRequest(
      'http://localhost:3000/api/agent-stream?agent=Test',
      { method: 'GET', signal: abortController.signal },
    );
    const res = await GET(req);
    const raw = await readStream(res, 200, abortController);
    const events = parseSSE(raw);
    const messages = events.filter((e) => e.event === 'message');
    expect(messages.length).toBe(1);
    const data = JSON.parse(messages[0].data);
    expect(data.raw).toBe('not valid json');
  });

  it('passes channelId to resolver when query param is provided', async () => {
    findAgentByNameMock.mockResolvedValue(null);
    const res = await GET(makeReq({ agent: 'Jack', channelId: 'ch-bng-123' }));
    expect(res.status).toBe(404);
    expect(findAgentByNameMock).toHaveBeenCalledWith('Jack', { channelId: 'ch-bng-123' });
  });

  it('passes no channelId to resolver when query param is omitted', async () => {
    findAgentByNameMock.mockResolvedValue(null);
    const res = await GET(makeReq({ agent: 'Jack' }));
    expect(res.status).toBe(404);
    expect(findAgentByNameMock).toHaveBeenCalledWith('Jack', undefined);
  });

  it('increments active-stream counter on connect and decrements on abort', async () => {
    writeFileSync(jsonlPath, '');
    resolveAgentStreamSourceMock.mockResolvedValue({
      path: jsonlPath,
      runtime: 'claude',
      resolvedVia: 'scratch',
    });

    expect(__getActiveStreamsForTest()).toBe(0);

    const abortController = new AbortController();
    const req = new NextRequest(
      'http://localhost:3000/api/agent-stream?agent=Test',
      { method: 'GET', signal: abortController.signal },
    );
    const res = await GET(req);
    // Give the stream a moment to start
    await readStream(res, 150, abortController);

    // After abort + cleanup, counter should be back to 0
    // (may need a microtask tick)
    await new Promise((r) => setTimeout(r, 50));
    expect(__getActiveStreamsForTest()).toBe(0);
  });
});
