import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeChange, fetchDocument, makeSnapshot, messageId, modelFacts, normalizeDocument, readWatchSnapshot, readWatchState, runWatch, WATCH_CHANNEL, WATCH_LIMITS, WATCH_RECIPIENTS, WATCH_SOURCES, WatchBusyError, type Receipt, type Source, type WatchDependencies, type WatchEvent } from '@/lib/typesafe-release-watch';

const models = `# Models
## Current models
| | Jev 1.14 | Jev 1.13 |
| :- | :- | :- |
| Model ID | \`jev-1.14.0\` | \`jev-1.13.0\` |
Newest release: Jev 1.14.
## Aliases
| Alias | Points to | Meaning |
| :- | :- | :- |
| \`jev-latest\` | \`jev-1.13.0\` | Stable release |
| \`jev-preview\` | \`jev-1.14.0\` | Most recent, official or not |
`;
let directory: string, docs: Record<Source, string>, errors: Set<Source>, deps: WatchDependencies;
let receiptStore: Map<string, Receipt>, sends: Array<{ event: WatchEvent; id: string }>;
const receiptFor = (event: WatchEvent, id: string): Receipt => ({ messageId: messageId(event, id), channelId: WATCH_CHANNEL, participantId: id, deliveryState: 'pending', deliveryRecordId: 'ledger-' + id });
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'typesafe-watch-'));
  docs = { models, images: '# Images\nPNG and JPEG images are experimental and require explicit opt-in.', box: '# Box\nLocate an image object using normalised edges. Always check presence.', api: '# System One\nPOST /v1/systemone accepts versioned models and typed questions.', errors: '# Request rules and errors\nBody at most 32 MiB; errors 400, 401, 413, 415, 422, 429, 529.', listModels: '# List models\nModels and aliases available to the authenticated account.', index: '# TypeSafe\n- [Models](https://docs.typesafe.ai/models.md)\n- [Images](https://docs.typesafe.ai/images.md)' };
  errors = new Set(); receiptStore = new Map(); sends = [];
  deps = {
    directory, fetchSource: async source => { if (errors.has(source)) throw new Error('HTTP 503'); return makeSnapshot(source, docs[source], new Date().toISOString()); },
    reconcile: async (event, id) => { const receipt = receiptStore.get(messageId(event, id)); return receipt ? { kind: 'accepted', receipt } : { kind: 'retryable' }; },
    deliver: async (event, id) => { const receipt = receiptFor(event, id); sends.push({ event, id }); receiptStore.set(receipt.messageId, receipt); return receipt; },
  };
});
afterEach(async () => { vi.unstubAllGlobals(); await fs.rm(directory, { recursive: true, force: true }); });

describe('TypeSafe change watch', () => {
  it('establishes a complete baseline and stays silent on repeat and restart', async () => {
    const first = await runWatch(deps); const second = await runWatch({ ...deps });
    expect(first).toMatchObject({ ok: true, sourceCount: 7, runs: 1, events: [] });
    expect(second).toMatchObject({ ok: true, runs: 2, events: [] }); expect(sends).toHaveLength(0);
    expect((await fs.stat(path.join(directory, 'state.json'))).mode & 0o777).toBe(0o600);
  });
  it('ignores whitespace, table spacing and generated navigation/footer', async () => {
    await runWatch(deps);
    docs.models = '> ## Documentation Index\n> Fetch the complete documentation index at: https://docs.typesafe.ai/llms.txt\n> Use this file to discover all available pages before exploring further.\n\n' + models.replaceAll(' | ', '   |    ').replaceAll('\n', '\r\n\r\n') + '\nThis documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.';
    expect(normalizeDocument(docs.models)).toBe(normalizeDocument(models));
    expect((await runWatch(deps)).events).toHaveLength(0);
  });
  it('reports a new version without calling the newest version stable', async () => {
    await runWatch(deps); docs.models = models.replace('jev-1.14.0', 'jev-1.15.0');
    await runWatch(deps); const e = (await readWatchState(directory)).events[0];
    expect(e.message).toContain('New listed model: jev-1.15.0'); expect(e.message).not.toContain('Stable alias:');
    expect(sends.map(s => s.id)).toEqual([...WATCH_RECIPIENTS]);
    await runWatch(deps); expect(sends).toHaveLength(2);
  });
  it('reports stable promotion from the explicit alias and preserves exact before/after evidence', async () => {
    await runWatch(deps); docs.models = models.replace('| `jev-latest` | `jev-1.13.0`', '| `jev-latest` | `jev-1.14.0`');
    await runWatch(deps); const event = (await readWatchState(directory)).events[0];
    expect(event.message).toContain('Stable alias: jev-1.13.0 → jev-1.14.0');
    const change = event.changes[0];
    expect((await readWatchSnapshot(directory, change.before)).raw).toBe(models);
    expect((await readWatchSnapshot(directory, change.after)).raw).toBe(docs.models);
  });
  it('reports capability-only changes and index additions without following discovered links', async () => {
    await runWatch(deps); docs.images += '\nMaximum image width is now 2048 pixels.'; docs.index += '\n- [New](https://untrusted.invalid/run-me)';
    const called: Source[] = []; const get = deps.fetchSource!;
    deps.fetchSource = async source => { called.push(source); return get(source); };
    await runWatch(deps); const event = (await readWatchState(directory)).events[0];
    expect(event.changes.map(c => c.source)).toEqual(['images', 'index']);
    expect(called.sort()).toEqual(Object.keys(WATCH_SOURCES).sort()); expect(event.message).not.toContain('untrusted.invalid');
  });
  it('retains unknown model changes as review notices instead of guessing stability', () => {
    const next = makeSnapshot('models', models.replace('| `jev-latest` | `jev-1.13.0`', '| `stable-v2` | `jev-1.14.0`'), 'now');
    expect(describeChange(makeSnapshot('models', models, 'before'), next).join()).toContain('not parsed; review required');
    expect(modelFacts(models).aliases['jev-latest']).toBe('jev-1.13.0');
  });
  it.each(['', '<!doctype html><html><title>Models</title>Access denied</html>', '# Models\nJust a moment, verify you are human before continuing.', '# Other\nThis is not the expected documentation response.'])('rejects missing/error/changed-shape response %j', raw => {
    expect(() => makeSnapshot('models', raw, 'now')).toThrow();
  });
  it('rejects oversized responses before baseline changes', () => {
    expect(() => makeSnapshot('models', '# Models\n' + 'a'.repeat(WATCH_LIMITS.sourceBytes), 'now')).toThrow('256 KiB');
  });
  it('does not establish a partial first baseline', async () => {
    errors.add('models'); expect((await runWatch(deps)).ok).toBe(false);
    expect((await readWatchState(directory)).sources).toEqual({}); expect(sends).toHaveLength(0);
    errors.clear(); expect((await runWatch(deps)).events).toHaveLength(0);
  });
  it('retains a failed source baseline, allows independent changes and deduplicates health/recovery episodes', async () => {
    await runWatch(deps); const before = (await readWatchState(directory)).sources.models!.hash;
    errors.add('models'); docs.images += '\nA capability changed.';
    await runWatch(deps); await runWatch(deps); await runWatch(deps); await runWatch(deps);
    let state = await readWatchState(directory);
    expect(state.sources.models!.hash).toBe(before); expect(state.failures.models?.consecutive).toBe(4);
    expect(state.events.map(e => e.kind)).toEqual(['change', 'health']); expect(sends).toHaveLength(4);
    errors.clear(); await runWatch(deps); await runWatch(deps); state = await readWatchState(directory);
    expect(state.events.map(e => e.kind)).toEqual(['change', 'health', 'recovery']); expect(state.failures).toEqual({}); expect(sends).toHaveLength(6);
  });
  it('reconciles a lost response after acceptance without another dispatch', async () => {
    await runWatch(deps); docs.images += '\nChanged.';
    const deliver = deps.deliver;
    deps.deliver = async (event, id) => { await deliver(event, id); throw new Error('response lost'); };
    expect((await runWatch(deps)).pendingEvents).toBe(1); expect(sends).toHaveLength(2);
    expect((await runWatch({ ...deps })).pendingEvents).toBe(0); expect(sends).toHaveLength(2);
  });
  it('keeps failed/unavailable recipients pending while preserving later changes', async () => {
    await runWatch(deps); const deliver = deps.deliver;
    deps.deliver = async (event, id) => { if (id === WATCH_RECIPIENTS[1]) throw new Error('target unavailable'); return deliver(event, id); };
    docs.images += '\nFirst change.'; await runWatch(deps);
    docs.images += '\nSecond change.'; const result = await runWatch(deps);
    expect(result.pendingEvents).toBe(2); expect(sends).toHaveLength(2);
    deps.deliver = deliver; expect((await runWatch(deps)).pendingEvents).toBe(0); expect(sends).toHaveLength(4);
  });
  it('does not dispatch ambiguous claims until positive reconciliation exists', async () => {
    await runWatch(deps); docs.images += '\nChanged.';
    deps.reconcile = async () => ({ kind: 'ambiguous', error: 'unconfirmed host handoff' });
    await runWatch(deps); await runWatch({ ...deps });
    expect(sends).toHaveLength(0); expect((await readWatchState(directory)).events[0].deliveries[WATCH_RECIPIENTS[0]].status).toBe('ambiguous');
    deps.reconcile = async (event, id) => ({ kind: 'accepted', receipt: receiptFor(event, id) });
    expect((await runWatch(deps)).pendingEvents).toBe(0); expect(sends).toHaveLength(0);
  });
  it('rejects a success receipt for a different channel/recipient/message', async () => {
    await runWatch(deps); docs.images += '\nChanged.';
    deps.deliver = async (event, id) => ({ ...receiptFor(event, id), participantId: 'wrong' });
    expect((await runWatch(deps)).ok).toBe(false);
    expect((await readWatchState(directory)).events[0].deliveries[WATCH_RECIPIENTS[0]].receipt).toBeUndefined();
  });
  it('records stopped-seat durable queue acceptance without claiming ingestion', async () => {
    await runWatch(deps); docs.images += '\nChanged.';
    deps.deliver = async (event, id) => ({ ...receiptFor(event, id), queuedWhileStopped: true });
    const result = await runWatch(deps);
    expect(result.ok).toBe(true); expect(result.events[0].deliveries[WATCH_RECIPIENTS[0]].receipt).toMatchObject({ deliveryState: 'pending', queuedWhileStopped: true });
  });
  it('bounds concurrent fetches', async () => {
    let active = 0, peak = 0; const get = deps.fetchSource!;
    deps.fetchSource = async source => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 5)); active--; return get(source); };
    await runWatch(deps); expect(peak).toBe(2);
  });
  it('excludes overlapping runs and recovers a verified dead-process lock', async () => {
    await fs.writeFile(path.join(directory, 'run.lock'), JSON.stringify({ pid: process.pid, host: os.hostname() }));
    await expect(runWatch(deps)).rejects.toBeInstanceOf(WatchBusyError);
    await fs.writeFile(path.join(directory, 'run.lock'), JSON.stringify({ pid: 2147483647, host: os.hostname() }));
    expect((await runWatch(deps)).ok).toBe(true);
  });
  it('does not replace corrupt state with a silent fresh baseline', async () => {
    await fs.writeFile(path.join(directory, 'state.json'), '{broken');
    await expect(runWatch(deps)).rejects.toThrow(); expect(await fs.readFile(path.join(directory, 'state.json'), 'utf8')).toBe('{broken');
  });
  it('synthetic routing is labelled, idempotent and does not touch the real baseline', async () => {
    await runWatch(deps); const before = await readWatchState(directory);
    await runWatch(deps, 'routing-20261015'); await runWatch(deps, 'routing-20261015');
    const after = await readWatchState(directory);
    expect(after.sources).toEqual(before.sources); expect(after.runs).toBe(before.runs); expect(sends).toHaveLength(2);
    expect(after.events[0].message).toContain('SYNTHETIC ROUTING CHECK'); expect(after.events[0].message).not.toContain('owner review requested');
  });
  it('prunes accepted evidence but retains all pending events and their snapshots', async () => {
    await runWatch(deps);
    for (let i = 0; i < 23; i++) { docs.images += `\nCapability ${i}.`; await runWatch(deps); }
    const state = await readWatchState(directory); expect(state.events).toHaveLength(20);
    for (const event of state.events) for (const change of event.changes) {
      expect(await readWatchSnapshot(directory, change.before)).toBeTruthy(); expect(await readWatchSnapshot(directory, change.after)).toBeTruthy();
    }
    expect((await fs.readdir(path.join(directory, 'snapshots'))).length).toBe(27); // 21 retained images versions + one current page for each of the 6 other sources
  });
  it('rejects HTTP failures, redirects/HTML and oversized streamed bodies', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('error', { status: 503 })));
    await expect(fetchDocument('models')).rejects.toThrow('HTTP 503');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>blocked</html>', { headers: { 'content-type': 'text/html' } })));
    await expect(fetchDocument('models')).rejects.toThrow('HTML');
    const mocked = vi.fn().mockResolvedValue(new Response('a'.repeat(WATCH_LIMITS.sourceBytes + 1)));
    vi.stubGlobal('fetch', mocked); await expect(fetchDocument('models')).rejects.toThrow('256 KiB');
    expect(mocked.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  });
});
