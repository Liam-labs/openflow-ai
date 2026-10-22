/**
 * Computer Use — screenshot coordinate mapping.
 *
 * The bridge clicks in virtual-desktop PHYSICAL pixels. A screenshot may be a
 * different size (monitor crop, region crop, downscale), and an agent's image
 * viewer may shrink it again. Every screenshot therefore carries a `mapping`
 * (image size, capture rectangle, scale) and a `screenshotId`. Click-type
 * actions can say `space: 'screenshot'` (optionally `screenshotId`, and
 * `viewWidth`/`viewHeight` if the caller measured a resized view) and DevFlow
 * converts to physical pixels — the caller never guesses a scale.
 *
 * Pure functions plus a small in-memory registry; no I/O.
 */

import { randomBytes } from 'crypto';

export interface ScreenshotMapping {
  space: 'virtual-desktop-physical';
  /** [left, top, width, height] of the captured rectangle, physical pixels. */
  captureRect: [number, number, number, number];
  /** [width, height] of the delivered image. */
  image: [number, number];
  /** Image pixels per physical pixel (1 = full resolution). */
  scaleX: number;
  scaleY: number;
  monitor?: number;
  monitorLabel?: string;
  primaryMonitor?: number;
  dpi?: number;
  dpiScale?: number;
  clickSpace?: string;
  formula?: string;
}

export interface RememberedScreenshot {
  screenshotId: string;
  mapping: ScreenshotMapping;
  at: number;
}

export interface ResolvedCoords {
  space: 'screenshot';
  screenshotId: string;
  /** Original values as sent, e.g. { x: 1066, y: 625 }. */
  from: Record<string, number>;
  /** Physical pixels actually sent to the bridge. */
  to: Record<string, number>;
  scaleX: number;
  scaleY: number;
}

const MAX_PER_SESSION = 8;
const MAX_SESSIONS = 64;
const registry = new Map<string, RememberedScreenshot[]>();

export function newScreenshotId(): string {
  return `shot-${randomBytes(3).toString('hex')}`;
}

/** Validate/normalise the mapping object the bridge returned. */
export function parseMapping(raw: unknown): ScreenshotMapping | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const rect = m.captureRect;
  const img = m.image;
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(num)) return null;
  if (!Array.isArray(img) || img.length !== 2 || !img.every(num)) return null;
  const scaleX = num(m.scaleX) ? (m.scaleX as number) : (img[0] as number) / (rect[2] as number);
  const scaleY = num(m.scaleY) ? (m.scaleY as number) : (img[1] as number) / (rect[3] as number);
  if (!(scaleX > 0) || !(scaleY > 0)) return null;
  return {
    ...(m as object),
    space: 'virtual-desktop-physical',
    captureRect: rect as ScreenshotMapping['captureRect'],
    image: img as ScreenshotMapping['image'],
    scaleX,
    scaleY,
  } as ScreenshotMapping;
}

export function rememberScreenshot(
  sessionId: string,
  mapping: ScreenshotMapping,
  screenshotId: string = newScreenshotId(),
): RememberedScreenshot {
  const entry: RememberedScreenshot = { screenshotId, mapping, at: Date.now() };
  const list = registry.get(sessionId) ?? [];
  list.push(entry);
  while (list.length > MAX_PER_SESSION) list.shift();
  registry.delete(sessionId);
  registry.set(sessionId, list); // re-insert = most recently used
  while (registry.size > MAX_SESSIONS) {
    const oldest = registry.keys().next().value;
    if (oldest === undefined) break;
    registry.delete(oldest);
  }
  return entry;
}

export function lookupScreenshot(sessionId: string, screenshotId?: string): RememberedScreenshot | null {
  const list = registry.get(sessionId);
  if (!list || list.length === 0) return null;
  if (!screenshotId) return list[list.length - 1];
  return list.find((e) => e.screenshotId === screenshotId) ?? null;
}

export function forgetSessionScreenshots(sessionId: string): void {
  registry.delete(sessionId);
}

export function _resetScreenshotRegistry(): void {
  registry.clear();
}

/** Find the latest (or named) screenshot in a persisted session's action log. */
export function findScreenshotInActions(
  actions: ReadonlyArray<{ type: string; result?: { screenshotId?: string; mapping?: unknown } }>,
  screenshotId?: string,
): RememberedScreenshot | null {
  for (let i = actions.length - 1; i >= 0; i--) {
    const a = actions[i];
    const id = a.result?.screenshotId;
    if (!id || (screenshotId && id !== screenshotId)) continue;
    const mapping = parseMapping(a.result?.mapping);
    if (mapping) return { screenshotId: id, mapping, at: 0 };
  }
  return null;
}

export interface ViewSize {
  viewWidth?: number;
  viewHeight?: number;
}

/**
 * Convert a point in screenshot-image pixels to physical click coordinates.
 * `view` lets a caller who measured a resized copy of the image say so:
 * coordinates are first scaled from that view to the delivered image.
 */
export function imagePointToPhysical(
  x: number,
  y: number,
  m: ScreenshotMapping,
  view: ViewSize = {},
): { x: number; y: number } {
  const fx = view.viewWidth && view.viewWidth > 0 ? m.image[0] / view.viewWidth : 1;
  const fy = view.viewHeight && view.viewHeight > 0 ? m.image[1] / view.viewHeight : view.viewWidth && view.viewWidth > 0 ? fx : 1;
  const ix = x * fx;
  const iy = y * fy;
  return {
    x: Math.round(m.captureRect[0] + ix / m.scaleX),
    y: Math.round(m.captureRect[1] + iy / m.scaleY),
  };
}

export function physicalPointToImage(x: number, y: number, m: ScreenshotMapping): { x: number; y: number } {
  return {
    x: Math.round((x - m.captureRect[0]) * m.scaleX),
    y: Math.round((y - m.captureRect[1]) * m.scaleY),
  };
}

/** True when the caller asked for screenshot-space coordinates. */
export function wantsScreenshotSpace(params: Record<string, unknown>): boolean {
  return params.space === 'screenshot' || typeof params.screenshotId === 'string';
}

/** Coordinate fields converted per bridge action type. */
const POINT_FIELDS: Record<string, Array<[string, string]>> = {
  click: [['x', 'y']],
  double_click: [['x', 'y']],
  right_click: [['x', 'y']],
  move: [['x', 'y']],
  scroll: [['x', 'y']],
  drag: [['x1', 'y1'], ['x2', 'y2']],
  'chat.send': [['x', 'y'], ['send_x', 'send_y']],
};
const REGION_FIELDS: Record<string, string[]> = {
  screenshot: ['region'],
  'chat.send': ['confirm_region'],
};

export function hasCoordinateFields(actionType: string): boolean {
  return actionType in POINT_FIELDS || actionType in REGION_FIELDS;
}

/** "x,y,w,h" string from a string, 4-array or {x,y,width,height}. */
export function regionToQuad(v: unknown): [number, number, number, number] | null {
  if (v === undefined || v === null || v === '') return null;
  let parts: unknown[] | null = null;
  if (typeof v === 'string') parts = v.split(',');
  else if (Array.isArray(v)) parts = v;
  else if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    parts = [o.x ?? o.left, o.y ?? o.top, o.width ?? o.w, o.height ?? o.h];
  }
  if (!parts || parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  if (!nums.every((n) => Number.isFinite(n))) return null;
  return nums as [number, number, number, number];
}

export class CoordinateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoordinateError';
  }
}

function checkInside(name: string, v: number, limit: number, m: ScreenshotMapping, id: string): void {
  // Half a pixel of slack for edge clicks.
  if (v < -0.5 || v > limit + 0.5) {
    throw new CoordinateError(
      `${name}=${v} is outside screenshot ${id} (${m.image[0]}x${m.image[1]}). ` +
      `Use pixel positions from that image; if you measured a resized copy, pass viewWidth/viewHeight.`,
    );
  }
}

/**
 * Return `params` with screenshot-space coordinates converted to physical
 * pixels for the bridge. Params not in screenshot space pass through unchanged
 * (region strings are still normalised to "x,y,w,h").
 */
export function resolveCoordinateParams(
  actionType: string,
  params: Record<string, unknown>,
  shot: RememberedScreenshot | null,
): { params: Record<string, unknown>; resolved: ResolvedCoords | null } {
  const points = POINT_FIELDS[actionType] ?? [];
  const regions = REGION_FIELDS[actionType] ?? [];
  const out: Record<string, unknown> = { ...params };

  const normaliseRegions = (convert: ((q: [number, number, number, number]) => [number, number, number, number]) | null) => {
    for (const key of regions) {
      if (out[key] === undefined || out[key] === null || out[key] === '') { delete out[key]; continue; }
      const q = regionToQuad(out[key]);
      if (!q) throw new CoordinateError(`${key} must be {x,y,width,height}, [x,y,w,h] or "x,y,w,h"`);
      const c = convert ? convert(q) : q;
      out[key] = c.map((n) => Math.round(n)).join(',');
    }
  };

  if (!wantsScreenshotSpace(params)) {
    normaliseRegions(null);
    return { params: out, resolved: null };
  }
  if (!shot) {
    throw new CoordinateError(
      typeof params.screenshotId === 'string'
        ? `Unknown screenshotId ${params.screenshotId} for this session (only the last ${MAX_PER_SESSION} are kept). Take a new screenshot.`
        : 'space:"screenshot" needs a screenshot taken in this session first.',
    );
  }
  const m = shot.mapping;
  const view: ViewSize = {
    viewWidth: typeof params.viewWidth === 'number' ? params.viewWidth : undefined,
    viewHeight: typeof params.viewHeight === 'number' ? params.viewHeight : undefined,
  };
  const from: Record<string, number> = {};
  const to: Record<string, number> = {};
  const iw = view.viewWidth ?? m.image[0];
  const ih = view.viewHeight ?? (view.viewWidth ? (view.viewWidth * m.image[1]) / m.image[0] : m.image[1]);

  for (const [kx, ky] of points) {
    const vx = out[kx];
    const vy = out[ky];
    if (vx === undefined || vx === null || vy === undefined || vy === null) continue;
    const x = Number(vx);
    const y = Number(vy);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new CoordinateError(`${kx}/${ky} must be numbers`);
    checkInside(kx, x, iw, m, shot.screenshotId);
    checkInside(ky, y, ih, m, shot.screenshotId);
    const p = imagePointToPhysical(x, y, m, view);
    from[kx] = x; from[ky] = y; to[kx] = p.x; to[ky] = p.y;
    out[kx] = p.x;
    out[ky] = p.y;
  }

  normaliseRegions((q) => {
    const a = imagePointToPhysical(q[0], q[1], m, view);
    const b = imagePointToPhysical(q[0] + q[2], q[1] + q[3], m, view);
    return [a.x, a.y, Math.max(1, b.x - a.x), Math.max(1, b.y - a.y)];
  });

  // The conversion fields are DevFlow-side only.
  for (const k of ['space', 'screenshotId', 'viewWidth', 'viewHeight']) delete out[k];
  return {
    params: out,
    resolved: { space: 'screenshot', screenshotId: shot.screenshotId, from, to, scaleX: m.scaleX, scaleY: m.scaleY },
  };
}
