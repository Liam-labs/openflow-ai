/**
 * Computer Use — Headless Backend (Playwright, in-process)
 *
 * Additive alternative backend to the Windows bridge (`lib/computer-use.ts` +
 * `lib/computer-use-bridge.ts`). Never imports from those modules; bridge
 * sessions remain byte-identical. Dispatched BEFORE `proxyAction()` when a
 * session was started with `mode: 'headless'`.
 *
 * Parity spec: `.DevData/docs/DevFlow/headless-session-mode.md`
 * Ref-format spike: `.DevData/docs/DevFlow/spike-1e872b56-ax-ref-parity.md`
 *
 * Isolation: one BrowserContext per session (cookies/storage/SW scoped).
 * Lifecycle: browser launched lazily on first session, torn down when the last
 * session closes or via explicit `disposeBrowserIfIdle()`.
 */

import { randomUUID } from 'crypto';
import type { Browser, BrowserContext, Page } from 'playwright';
import { appendAction, ComputerUseError } from './computer-use';
import { PRODUCT_NAME } from '@/lib/brand';
import type {
  ComputerUseAction,
  ComputerUseActionType,
  HeadlessSessionConfig,
} from './types';

// ─── Playwright runtime ──────────────────────────────────────────────────────

type PlaywrightModule = typeof import('playwright');

let _playwrightModule: PlaywrightModule | null = null;

// `HeadlessRuntimeError` was folded into `ComputerUseError` per taxonomy §4.2.
// Headless-specific failures now throw `ComputerUseError` with
// `context.headlessSessionId` so callers can distinguish headless from
// bridge-routed sessions without a separate class. External `instanceof`
// checks should be updated to `err instanceof ComputerUseError`.

async function ensurePlaywrightRuntime(): Promise<PlaywrightModule> {
  if (_playwrightModule) return _playwrightModule;
  try {
    _playwrightModule = await import('playwright');
    return _playwrightModule;
  } catch {
    throw new ComputerUseError(
      `Playwright not installed. Run 'npm install playwright && npx playwright install chromium' in ${PRODUCT_NAME}.`,
      'COMPUTER_USE_PLAYWRIGHT_MISSING',
      501
    );
  }
}

// ─── Browser + session registry ──────────────────────────────────────────────

interface HeadlessHandle {
  context: BrowserContext;
  page: Page;
  config: HeadlessSessionConfig;
}

let _browser: Browser | null = null;
let _browserRefCount = 0;
const _registry: Map<string, HeadlessHandle> = new Map();

// Cap per spec §8: default 8 concurrent headless sessions
const DEFAULT_MAX_CONCURRENT = 8;

// ─── Lifecycle mutex ─────────────────────────────────────────────────────────
// Promise-chain queue that serialises mutations to `_browser`, `_browserRefCount`,
// and `_registry`. Prior code race: two concurrent stop calls could both observe
// "registry empty + refcount==0" between awaits and both attempt to close the
// browser, or one stop's `_browser = null` could clobber a sibling start's
// just-launched browser, leaving an orphan chromium process. Wrapping every
// shared-state transition in this queue makes lifecycle transitions atomic.
//
// Non-reentrant: callers inside a locked region must NOT call withLifecycleLock
// again — that would deadlock. Inline the logic instead.
let _lifecycleQueue: Promise<unknown> = Promise.resolve();
function withLifecycleLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = _lifecycleQueue.then(fn, fn);
  _lifecycleQueue = next.catch(() => undefined);
  return next;
}

async function ensureBrowser(): Promise<Browser> {
  if (_browser && _browser.isConnected()) return _browser;
  const pw = await ensurePlaywrightRuntime();
  try {
    _browser = await pw.chromium.launch({ headless: true });
  } catch (err) {
    const msg = (err as Error).message ?? 'Failed to launch Chromium';
    // Taxonomy §5.4: chromium import succeeded (we got past ensurePlaywrightRuntime),
    // but launch() failed — that's a runtime headless failure, not a missing dep.
    throw new ComputerUseError(
      `Chromium launch failed: ${msg}. Try 'npx playwright install chromium'.`,
      'COMPUTER_USE_HEADLESS_LAUNCH_FAILED',
      500,
    );
  }
  return _browser;
}

export function hasHeadlessSession(sessionId: string): boolean {
  return _registry.has(sessionId);
}

export function headlessSessionCount(): number {
  return _registry.size;
}

// ─── Start / stop ────────────────────────────────────────────────────────────

export interface StartHeadlessOptions {
  sessionId: string;
  viewport?: { width: number; height: number };
  userAgent?: string;
  startUrl?: string;
  maxConcurrent?: number;
}

export async function startHeadlessSession(
  opts: StartHeadlessOptions
): Promise<{ config: HeadlessSessionConfig }> {
  const cap = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const viewport = opts.viewport ?? { width: 1280, height: 800 };
  const config: HeadlessSessionConfig = {
    engine: 'chromium',
    viewport,
    userAgent: opts.userAgent,
    startUrl: opts.startUrl,
  };

  // Reserve capacity + ensure browser under lifecycle lock so the cap check
  // and refcount mutation are atomic with respect to concurrent start/stop.
  // Cap is checked against `_browserRefCount` (not `_registry.size`) so that
  // parallel in-flight starts which haven't yet joined the registry still
  // count toward capacity — preventing over-allocation.
  const browser = await withLifecycleLock(async () => {
    if (_browserRefCount >= cap) {
      throw new ComputerUseError(
        `Headless session cap reached (${cap}). Stop an existing headless session first.`,
        'COMPUTER_USE_HEADLESS_AT_CAPACITY',
        429
      );
    }
    _browserRefCount += 1;
    try {
      return await ensureBrowser();
    } catch (err) {
      _browserRefCount -= 1;
      throw err;
    }
  });

  // Per-session resource creation runs OUTSIDE the lock so parallel starts
  // can create their contexts/pages concurrently — only refcount/_browser
  // mutations need serialisation.
  let context: BrowserContext;
  try {
    context = await browser.newContext({
      viewport,
      userAgent: opts.userAgent,
    });
  } catch (err) {
    // Roll back the refcount reservation under the lock; close browser if we
    // were the last one holding it open.
    await withLifecycleLock(async () => {
      if (_browserRefCount > 0) _browserRefCount -= 1;
      if (_browser && _browserRefCount === 0 && _registry.size === 0) {
        try { await _browser.close(); } catch { /* best-effort */ }
        _browser = null;
      }
    });
    throw new ComputerUseError(
      `Failed to create browser context: ${(err as Error).message}`,
      'COMPUTER_USE_HEADLESS_LAUNCH_FAILED',
      500,
      { headlessSessionId: opts.sessionId },
    );
  }

  const page = await context.newPage();
  if (opts.startUrl) {
    try {
      await page.goto(opts.startUrl, { waitUntil: 'load', timeout: 15000 });
    } catch {
      /* start-url failure is non-fatal; caller can explicitly navigate via `key: 'F5'` or re-goto */
    }
  }

  _registry.set(opts.sessionId, { context, page, config });
  return { config };
}

export async function stopHeadlessSession(sessionId: string): Promise<void> {
  // Entire stop transaction (registry remove → context close → refcount
  // decrement → browser dispose) runs under the lifecycle lock so concurrent
  // stops on the same session can't double-close the context or
  // double-decrement the refcount, and the "last one out" check is atomic
  // with the actual close.
  return withLifecycleLock(async () => {
    const handle = _registry.get(sessionId);
    if (!handle) return; // idempotent — another stop already removed it
    _registry.delete(sessionId);
    try {
      await handle.context.close();
    } catch { /* best-effort */ }
    if (_browserRefCount > 0) _browserRefCount -= 1;
    if (_browser && _browserRefCount === 0 && _registry.size === 0) {
      try { await _browser.close(); } catch { /* best-effort */ }
      _browser = null;
    }
  });
}

/** Best-effort dispose called from the zombie-cleanup sweep. Never throws. */
export async function disposeHeadlessRegistryEntry(sessionId: string): Promise<void> {
  try {
    await stopHeadlessSession(sessionId);
  } catch { /* swallow */ }
}

function getHandleOrThrow(sessionId: string): HeadlessHandle {
  const handle = _registry.get(sessionId);
  if (!handle) {
    throw new ComputerUseError(
      'Headless session handle not found (server may have restarted). Call session.start again.',
      'COMPUTER_USE_SESSION_LOST',
      410,
      { headlessSessionId: sessionId },
    );
  }
  return handle;
}

// ─── AX-tree serialization (ported from scripts/cdp_connector.py) ────────────

const SKIP_ROLES = new Set(['none', 'generic', 'InlineTextBox', 'StaticText']);

interface AxNode {
  role: string;
  name: string;
  children: AxNode[];
  disabled?: unknown;
  checked?: unknown;
  expanded?: unknown;
  selected?: unknown;
  required?: unknown;
  value?: unknown;
}

interface CdpAxNode {
  nodeId: string;
  parentId?: string;
  childIds?: string[];
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: unknown };
  properties?: Array<{ name: string; value?: { value?: unknown } }>;
}

function mapCdpNode(
  nodeById: Map<string, CdpAxNode>,
  id: string | undefined
): AxNode | AxNode[] | null {
  if (!id) return null;
  const node = nodeById.get(id);
  if (!node) return null;

  // For ignored nodes, flatten children up so we don't lose the tree structure.
  if (node.ignored) {
    const flat: AxNode[] = [];
    for (const cid of node.childIds ?? []) {
      const mapped = mapCdpNode(nodeById, cid);
      if (mapped == null) continue;
      if (Array.isArray(mapped)) flat.push(...mapped);
      else flat.push(mapped);
    }
    return flat.length > 0 ? flat : null;
  }

  const out: AxNode = {
    role: node.role?.value ?? '',
    name: node.name?.value ?? '',
    children: [],
  };

  for (const prop of node.properties ?? []) {
    const v = prop.value?.value;
    if (v === undefined) continue;
    if (prop.name === 'disabled' && v) out.disabled = v;
    if (prop.name === 'checked') out.checked = v;
    if (prop.name === 'expanded') out.expanded = v;
    if (prop.name === 'selected') out.selected = v;
    if (prop.name === 'required') out.required = v;
  }
  if (node.value?.value !== undefined) out.value = node.value.value;

  for (const cid of node.childIds ?? []) {
    const mapped = mapCdpNode(nodeById, cid);
    if (mapped == null) continue;
    if (Array.isArray(mapped)) out.children.push(...mapped);
    else out.children.push(mapped);
  }
  return out;
}

interface SerializeRef { role: string; name: string; }

function serializeAxNode(
  node: AxNode,
  refs: Record<string, SerializeRef>,
  depth: number,
  counter: { n: number }
): string {
  const { role, name, children } = node;
  if (SKIP_ROLES.has(role) && children.length === 0) return '';

  counter.n += 1;
  const ref = `e${counter.n}`;

  const indent = '  '.repeat(depth);
  const parts: string[] = [`${indent}- ${role}`];
  if (name) {
    const display = name.length > 120 ? name.slice(0, 120) + '...' : name;
    parts.push(`"${display}"`);
  }
  parts.push(`[ref=${ref}]`);

  const states: string[] = [];
  if (node.disabled) states.push('disabled');
  if (node.checked !== undefined && node.checked !== null) states.push(`checked=${node.checked}`);
  if (node.expanded !== undefined && node.expanded !== null) states.push(`expanded=${node.expanded}`);
  if (node.selected) states.push('selected');
  if (node.required) states.push('required');
  if (node.value !== undefined && node.value !== null && node.value !== '') {
    const v = String(node.value).slice(0, 60);
    states.push(`value="${v}"`);
  }
  if (states.length > 0) parts.push(`(${states.join(', ')})`);

  const line = parts.join(' ');
  refs[ref] = { role, name: name ? name.slice(0, 200) : '' };

  const childLines: string[] = [];
  for (const child of children) {
    const text = serializeAxNode(child, refs, depth + 1, counter);
    if (text) childLines.push(text);
  }
  return childLines.length > 0 ? `${line}\n${childLines.join('\n')}` : line;
}

async function captureAxTree(page: Page): Promise<{ tree: string; refs: Record<string, SerializeRef> }> {
  const ctx = page.context();
  const client = await ctx.newCDPSession(page);
  try {
    await client.send('Accessibility.enable');
    const { nodes } = (await client.send('Accessibility.getFullAXTree')) as { nodes: CdpAxNode[] };
    const byId = new Map<string, CdpAxNode>();
    for (const n of nodes) byId.set(n.nodeId, n);
    const rootId = nodes[0]?.nodeId;
    const mapped = mapCdpNode(byId, rootId);
    const root: AxNode = Array.isArray(mapped)
      ? { role: 'RootWebArea', name: '', children: mapped }
      : (mapped ?? { role: 'RootWebArea', name: '', children: [] });
    const refs: Record<string, SerializeRef> = {};
    const tree = serializeAxNode(root, refs, 0, { n: 0 });
    return { tree, refs };
  } finally {
    try { await client.detach(); } catch { /* noop */ }
  }
}

// ─── Action handlers (Phase A routing table — see spec §5) ───────────────────

async function audit(
  sessionId: string,
  type: ComputerUseActionType,
  params: Record<string, unknown>,
  result: ComputerUseAction['result']
): Promise<ComputerUseAction> {
  // Strip request-routing fields (mirrors proxyAction audit behavior)
  const { action: _action, sessionId: _sessionId, ...auditParams } =
    params as Record<string, unknown> & { action?: unknown; sessionId?: unknown };
  const action: ComputerUseAction = {
    id: randomUUID(),
    type,
    params: auditParams,
    result,
    timestamp: new Date().toISOString(),
  };
  await appendAction(sessionId, action);
  return action;
}

function toNumber(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

export async function headlessScreenshot(
  sessionId: string,
  params: Record<string, unknown>
): Promise<ComputerUseAction> {
  const h = getHandleOrThrow(sessionId);
  const start = Date.now();
  const format = (params.format as string | undefined) === 'jpeg' ? 'jpeg' : 'png';
  const buf = await h.page.screenshot({ type: format, fullPage: !!params.fullPage });
  const imageBase64 = buf.toString('base64');
  const size = h.page.viewportSize();
  const durationMs = Date.now() - start;
  return audit(sessionId, 'screenshot', params, {
    success: true,
    imageBase64,
    imageFormat: format,
    imageWidth: size?.width,
    imageHeight: size?.height,
    durationMs,
  });
}

export async function headlessClick(
  sessionId: string,
  params: Record<string, unknown>
): Promise<ComputerUseAction> {
  const h = getHandleOrThrow(sessionId);
  const start = Date.now();
  const x = toNumber(params.x, 0);
  const y = toNumber(params.y, 0);
  const button = (params.button as 'left' | 'right' | 'middle') ?? 'left';
  await h.page.mouse.click(x, y, { button });
  return audit(sessionId, 'click', params, { success: true, durationMs: Date.now() - start });
}

export async function headlessDoubleClick(
  sessionId: string,
  params: Record<string, unknown>
): Promise<ComputerUseAction> {
  const h = getHandleOrThrow(sessionId);
  const start = Date.now();
  await h.page.mouse.click(toNumber(params.x, 0), toNumber(params.y, 0), { clickCount: 2 });
  return audit(sessionId, 'double_click', params, { success: true, durationMs: Date.now() - start });
}

export async function headlessRightClick(
  sessionId: string,
  params: Record<string, unknown>
): Promise<ComputerUseAction> {
  const h = getHandleOrThrow(sessionId);
  const start = Date.now();
  await h.page.mouse.click(toNumber(params.x, 0), toNumber(params.y, 0), { button: 'right' });
  return audit(sessionId, 'right_click', params, { success: true, durationMs: Date.now() - start });
}

export async function headlessMove(
  sessionId: string,
  params: Record<string, unknown>
): Promise<ComputerUseAction> {
  const h = getHandleOrThrow(sessionId);
  const start = Date.now();
  await h.page.mouse.move(toNumber(params.x, 0), toNumber(params.y, 0));
  return audit(sessionId, 'move', params, { success: true, durationMs: Date.now() - start });
}

export async function headlessDrag(
  sessionId: string,
  params: Record<string, unknown>
): Promise<ComputerUseAction> {
  const h = getHandleOrThrow(sessionId);
  const start = Date.now();
  const x1 = toNumber(params.x1, 0);
  const y1 = toNumber(params.y1, 0);
  const x2 = toNumber(params.x2, 0);
  const y2 = toNumber(params.y2, 0);
  await h.page.mouse.move(x1, y1);
  await h.page.mouse.down();
  await h.page.mouse.move(x2, y2);
  await h.page.mouse.up();
  return audit(sessionId, 'drag', params, { success: true, durationMs: Date.now() - start });
}

export async function headlessScroll(
  sessionId: string,
  params: Record<string, unknown>
): Promise<ComputerUseAction> {
  const h = getHandleOrThrow(sessionId);
  const start = Date.now();
  const x = toNumber(params.x, 0);
  const y = toNumber(params.y, 0);
  const amount = toNumber(params.amount, 3);
  const direction = String(params.direction ?? 'down');
  const sign = direction === 'up' || direction === 'left' ? -1 : 1;
  const axis = direction === 'left' || direction === 'right' ? 'x' : 'y';
  await h.page.mouse.move(x, y);
  await h.page.mouse.wheel(
    axis === 'x' ? sign * amount * 100 : 0,
    axis === 'y' ? sign * amount * 100 : 0
  );
  return audit(sessionId, 'scroll', params, { success: true, durationMs: Date.now() - start });
}

export async function headlessType(
  sessionId: string,
  params: Record<string, unknown>
): Promise<ComputerUseAction> {
  const h = getHandleOrThrow(sessionId);
  const start = Date.now();
  const text = String(params.text ?? '');
  const interval = toNumber(params.interval, 0.01);
  await h.page.keyboard.type(text, { delay: Math.max(0, interval * 1000) });
  return audit(sessionId, 'type', params, { success: true, durationMs: Date.now() - start });
}

// Bridge 'keys' strings are a superset of Playwright-accepted tokens; for Phase A
// we pass the string through unchanged. Explicit combos (e.g. 'Control+A') are
// supported by Playwright's keyboard.press directly.
export async function headlessKey(
  sessionId: string,
  params: Record<string, unknown>
): Promise<ComputerUseAction> {
  const h = getHandleOrThrow(sessionId);
  const start = Date.now();
  const keys = String(params.keys ?? '');
  await h.page.keyboard.press(keys);
  return audit(sessionId, 'key', params, { success: true, durationMs: Date.now() - start });
}

export async function headlessDomSnapshot(
  sessionId: string,
  params: Record<string, unknown>
): Promise<{ action: ComputerUseAction; tree: string; refs: Record<string, SerializeRef>; url: string; title: string }> {
  const h = getHandleOrThrow(sessionId);
  const start = Date.now();
  const { tree, refs } = await captureAxTree(h.page);
  const durationMs = Date.now() - start;
  const url = h.page.url();
  const title = await h.page.title();
  const action = await audit(sessionId, 'dom.snapshot', params, { success: true, durationMs });
  return { action, tree, refs, url, title };
}

// Cached per-session AX refs so dom.click / dom.type can resolve without a re-snapshot.
// Bridge behaviour re-snapshots on each call (`find_element_by_ref` in cdp_connector.py);
// we mirror that here for the same "refs are per-snapshot" semantics.
async function resolveRef(page: Page, ref: string) {
  const { refs } = await captureAxTree(page);
  const meta = refs[ref];
  if (!meta) {
    throw new ComputerUseError(
      `Ref '${ref}' not found in current accessibility tree`,
      'COMPUTER_USE_DOM_REF_NOT_FOUND',
      404,
      { ref },
    );
  }
  const { role, name } = meta;
  // Playwright's ARIA role list excludes the internal 'RootWebArea'/'StaticText'/etc.
  // For those we fall back to a text locator on the name.
  const ARIA_ROLES = new Set([
    'alert','alertdialog','application','article','banner','blockquote','button','caption',
    'cell','checkbox','code','columnheader','combobox','complementary','contentinfo','definition',
    'deletion','dialog','directory','document','emphasis','feed','figure','form','generic',
    'grid','gridcell','group','heading','img','insertion','link','list','listbox','listitem',
    'log','main','marquee','math','meter','menu','menubar','menuitem','menuitemcheckbox',
    'menuitemradio','navigation','none','note','option','paragraph','presentation','progressbar',
    'radio','radiogroup','region','row','rowgroup','rowheader','scrollbar','search','searchbox',
    'separator','slider','spinbutton','status','strong','subscript','superscript','switch','tab',
    'table','tablist','tabpanel','term','textbox','time','timer','toolbar','tooltip','tree',
    'treegrid','treeitem',
  ]);
  if (ARIA_ROLES.has(role)) {
    const locator = name ? page.getByRole(role as Parameters<Page['getByRole']>[0], { name }) : page.getByRole(role as Parameters<Page['getByRole']>[0]);
    const count = await locator.count();
    if (count === 0) {
      throw new ComputerUseError(
        `No element for ref=${ref} (role=${role}, name=${name})`,
        'COMPUTER_USE_DOM_REF_NOT_FOUND',
        404,
        { ref },
      );
    }
    return count > 1 ? locator.first() : locator;
  }
  // Fallback: text locator — non-ARIA roles (e.g. RootWebArea) are not interactive anyway.
  if (!name) {
    throw new ComputerUseError(
      `Ref '${ref}' resolves to a non-ARIA role (${role}) with no name — not interactable`,
      'COMPUTER_USE_DOM_REF_NOT_INTERACTABLE',
      400,
      { ref },
    );
  }
  return page.getByText(name, { exact: true }).first();
}

export async function headlessDomClick(
  sessionId: string,
  params: Record<string, unknown>
): Promise<ComputerUseAction> {
  const h = getHandleOrThrow(sessionId);
  const start = Date.now();
  const ref = String(params.ref ?? '');
  const locator = await resolveRef(h.page, ref);
  await locator.click();
  return audit(sessionId, 'dom.click', params, { success: true, durationMs: Date.now() - start });
}

export async function headlessDomType(
  sessionId: string,
  params: Record<string, unknown>
): Promise<ComputerUseAction> {
  const h = getHandleOrThrow(sessionId);
  const start = Date.now();
  const ref = String(params.ref ?? '');
  const text = String(params.text ?? '');
  const clear = !!params.clear;
  const locator = await resolveRef(h.page, ref);
  if (clear) await locator.fill(text);
  else await locator.type(text);
  return audit(sessionId, 'dom.type', params, { success: true, durationMs: Date.now() - start });
}

export async function headlessDomSelect(
  sessionId: string,
  params: Record<string, unknown>
): Promise<ComputerUseAction> {
  const h = getHandleOrThrow(sessionId);
  const start = Date.now();
  const ref = String(params.ref ?? '');
  const value = String(params.value ?? '');
  const locator = await resolveRef(h.page, ref);
  await locator.selectOption(value);
  return audit(sessionId, 'dom.select', params, { success: true, durationMs: Date.now() - start });
}

export async function headlessContextDetect(
  sessionId: string
): Promise<{ type: 'browser'; process: string; title: string; url: string }> {
  const h = getHandleOrThrow(sessionId);
  return {
    type: 'browser',
    process: 'chromium-headless',
    title: await h.page.title(),
    url: h.page.url(),
  };
}

/** Convenience for abebb64a demo + UI: navigate the session's page. */
export async function headlessGoto(
  sessionId: string,
  url: string,
  timeoutMs = 15000
): Promise<void> {
  const h = getHandleOrThrow(sessionId);
  await h.page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
}

// ─── Delivery Evidence review capture ──────────────────────────────────────

export interface HeadlessAccessibilityFinding {
  code: 'heading_hierarchy' | 'insufficient_contrast' | 'missing_alt' | 'aria_violation';
  severity: 'p1' | 'p2' | 'p3';
  summary: string;
  selector: string;
}

export interface HeadlessReviewCaptureOptions {
  url: string;
  timeoutMs: number;
  fullPage: boolean;
  maxArtifactBytes: number;
  /** Server-owned selector resolved from the registered verification input profile. */
  renderedReadiness?: { selector: string };
}

export interface HeadlessReviewCaptureResult {
  screenshot: Buffer;
  accessibilityTree: string;
  consoleErrors: string[];
  networkFailures: Array<{ url: string; status: number }>;
  accessibilityFindings: HeadlessAccessibilityFinding[];
}

interface PageConsoleMessage {
  type(): string;
  text(): string;
}

interface PageResponse {
  status(): number;
  url(): string;
}

function isLoopbackReviewUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]')
    );
  } catch {
    return false;
  }
}

// Playwright serializes page functions before running them in Chromium. The
// project transpiler decorates nested TypeScript functions with a module-scoped
// helper, which does not exist in the browser realm. Keep this deterministic,
// server-owned audit as plain JavaScript so the evaluated source is self-contained.
const HEADLESS_ACCESSIBILITY_AUDIT_SCRIPT = String.raw`(() => {
  const findings = [];

  function selectorFor(element) {
    if (element.id) return '#' + CSS.escape(element.id);
    const tag = element.tagName.toLowerCase();
    const parent = element.parentElement;
    if (!parent) return tag;
    const peers = Array.from(parent.children).filter((child) => child.tagName === element.tagName);
    return peers.length > 1 ? tag + ':nth-of-type(' + (peers.indexOf(element) + 1) + ')' : tag;
  }

  for (const image of Array.from(document.querySelectorAll('img:not([alt])')).slice(0, 500)) {
    findings.push({
      code: 'missing_alt',
      severity: 'p2',
      summary: 'Image is missing an alt attribute.',
      selector: selectorFor(image),
    });
  }

  let previousHeadingLevel = 0;
  for (const heading of Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).slice(0, 500)) {
    const level = Number(heading.tagName.slice(1));
    if (previousHeadingLevel > 0 && level > previousHeadingLevel + 1) {
      findings.push({
        code: 'heading_hierarchy',
        severity: 'p2',
        summary: 'Heading level skips from h' + previousHeadingLevel + ' to h' + level + '.',
        selector: selectorFor(heading),
      });
    }
    previousHeadingLevel = level;
  }

  const focusableSelector = 'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])';
  for (const hidden of Array.from(document.querySelectorAll('[aria-hidden="true"]')).slice(0, 500)) {
    if (hidden.matches(focusableSelector) || hidden.querySelector(focusableSelector)) {
      findings.push({
        code: 'aria_violation',
        severity: 'p1',
        summary: 'aria-hidden content contains a keyboard-focusable control.',
        selector: selectorFor(hidden),
      });
    }
  }

  for (const element of Array.from(document.querySelectorAll('[aria-labelledby],[aria-describedby]')).slice(0, 1000)) {
    for (const attribute of ['aria-labelledby', 'aria-describedby']) {
      const refs = (element.getAttribute(attribute) || '').trim().split(/\s+/).filter(Boolean);
      if (refs.some((id) => !document.getElementById(id))) {
        findings.push({
          code: 'aria_violation',
          severity: 'p2',
          summary: attribute + ' references an element that does not exist.',
          selector: selectorFor(element),
        });
      }
    }
  }

  const requiredAriaState = {
    checkbox: ['aria-checked'],
    radio: ['aria-checked'],
    slider: ['aria-valuemin', 'aria-valuemax', 'aria-valuenow'],
    spinbutton: ['aria-valuenow'],
  };
  for (const element of Array.from(document.querySelectorAll('[role]')).slice(0, 1000)) {
    const role = element.getAttribute('role') || '';
    const missing = (requiredAriaState[role] || []).filter((attribute) => !element.hasAttribute(attribute));
    if (missing.length > 0) {
      findings.push({
        code: 'aria_violation',
        severity: 'p2',
        summary: 'Role ' + role + ' is missing required state: ' + missing.join(', ') + '.',
        selector: selectorFor(element),
      });
    }
  }

  function parseRgb(value) {
    const match = value.match(/^rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/i);
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  }

  function luminance(rgb) {
    const channels = rgb.map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045
        ? normalized / 12.92
        : Math.pow((normalized + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }

  function resolvedBackground(element) {
    let current = element;
    while (current) {
      const color = getComputedStyle(current).backgroundColor;
      if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') return color;
      current = current.parentElement;
    }
    return 'rgb(255, 255, 255)';
  }

  const textElements = Array.from(document.querySelectorAll('body *'))
    .filter((element) => {
      const style = getComputedStyle(element);
      const ownText = Array.from(element.childNodes)
        .some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent || '').trim());
      return ownText && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    })
    .slice(0, 2000);
  for (const element of textElements) {
    const style = getComputedStyle(element);
    const foreground = parseRgb(style.color);
    const background = parseRgb(resolvedBackground(element));
    if (!foreground || !background) continue;
    const lighter = Math.max(luminance(foreground), luminance(background));
    const darker = Math.min(luminance(foreground), luminance(background));
    const ratio = (lighter + 0.05) / (darker + 0.05);
    const fontSize = Number.parseFloat(style.fontSize);
    const fontWeight = Number.parseInt(style.fontWeight, 10) || 400;
    const largeText = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
    const requiredRatio = largeText ? 3 : 4.5;
    if (ratio + 0.01 < requiredRatio) {
      findings.push({
        code: 'insufficient_contrast',
        severity: 'p2',
        summary: 'Text contrast ' + ratio.toFixed(2) + ':1 is below ' + requiredRatio + ':1.',
        selector: selectorFor(element),
      });
    }
  }

  return findings.slice(0, 10000);
})()`;

/**
 * One bounded, deterministic capture transaction for Delivery Evidence.
 *
 * The caller owns session lifecycle. This primitive deliberately exposes no
 * generic page/evaluate handle: navigation stays loopback-only and the DOM
 * inspection program is server-owned rather than model-authored JavaScript.
 */
export async function headlessReviewCapture(
  sessionId: string,
  options: HeadlessReviewCaptureOptions,
): Promise<HeadlessReviewCaptureResult> {
  const handle = getHandleOrThrow(sessionId);
  if (!isLoopbackReviewUrl(options.url)) {
    throw new ComputerUseError(
      'Visual Review navigation is restricted to loopback previews',
      'COMPUTER_USE_HEADLESS_NAVIGATION_DENIED',
      403,
      { headlessSessionId: sessionId },
    );
  }

  const consoleErrors: string[] = [];
  const networkFailures: Array<{ url: string; status: number }> = [];
  const onConsole = (message: PageConsoleMessage) => {
    if (message.type() !== 'error' || consoleErrors.length >= 1_000) return;
    consoleErrors.push(message.text().slice(0, 20_000));
  };
  const onResponse = (response: PageResponse) => {
    const status = response.status();
    if (status < 400 || status > 599 || networkFailures.length >= 10_000) return;
    networkFailures.push({ url: response.url(), status });
  };

  handle.page.on('console', onConsole);
  handle.page.on('response', onResponse);
  try {
    try {
      await handle.page.goto(options.url, {
        waitUntil: 'load',
        timeout: options.timeoutMs,
      });
    } catch {
      throw new ComputerUseError(
        'Visual Review could not load the requested preview route',
        'COMPUTER_USE_HEADLESS_NAVIGATION_FAILED',
        502,
        { headlessSessionId: sessionId },
      );
    }

    if (options.renderedReadiness) {
      try {
        await handle.page.locator(options.renderedReadiness.selector).waitFor({
          state: 'visible',
          timeout: options.timeoutMs,
        });
      } catch {
        throw new ComputerUseError(
          'Visual Review route did not reach its registered rendered-ready state',
          'COMPUTER_USE_HEADLESS_RENDERED_NOT_READY',
          504,
          { headlessSessionId: sessionId },
        );
      }
    }

    const screenshot = await handle.page.screenshot({
      type: 'png',
      fullPage: options.fullPage,
    });
    if (screenshot.byteLength > options.maxArtifactBytes) {
      throw new ComputerUseError(
        'Visual Review screenshot exceeds the registered artifact limit',
        'COMPUTER_USE_HEADLESS_ARTIFACT_TOO_LARGE',
        413,
        { headlessSessionId: sessionId },
      );
    }

    const { tree: accessibilityTree } = await captureAxTree(handle.page);
    const accessibilityFindings = await handle.page.evaluate(
      HEADLESS_ACCESSIBILITY_AUDIT_SCRIPT,
    ) as HeadlessAccessibilityFinding[];

    return {
      screenshot,
      accessibilityTree,
      consoleErrors,
      networkFailures,
      accessibilityFindings,
    };
  } finally {
    handle.page.off('console', onConsole);
    handle.page.off('response', onResponse);
  }
}
