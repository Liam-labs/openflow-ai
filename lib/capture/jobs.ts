/**
 * The hand-off between a request for a screenshot and the device that takes it. No WebSocket and no open port on the device:
 * the agent calls /api/capture/agent/poll and the server holds that request open until there is a job (a long poll over HTTPS).
 * It lives in this process's memory. A job lasts seconds, so nothing needs to survive a restart.
 */
import crypto from 'crypto';
import { authenticateDevice, appendLog, type Device } from './devices';

export const ACK_MS = 3500;          // how long the device may take to pick a job up
export const RESULT_MS = 25_000;     // how long it may take to send the picture
export const POLL_HOLD_MS = 20_000;  // how long one poll waits for a job
export const ONLINE_MS = POLL_HOLD_MS + 8_000;
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

export interface CaptureParams { monitor: number; scale: number; quality: number }
export type CaptureState = 'ok' | 'offline' | 'paused' | 'locked' | 'off' | 'blank' | 'error' | 'timeout' | 'busy' | 'revoked';
export interface CaptureResult { state: CaptureState; image?: Buffer; message: string }

interface Job { id: string; deviceId: string; params: CaptureParams; requester: string; deviceName: string; picked: boolean; settle: (r: CaptureResult) => void; timers: NodeJS.Timeout[] }
interface Hub {
  jobs: Map<string, Job>;
  waiting: Map<string, (job: Job | null) => void>;  // deviceId -> the poll that is holding
  seen: Map<string, number>;
}

const KEY = Symbol.for('openflow.captureHub');
function hub(): Hub {
  const g = globalThis as Record<symbol, Hub | undefined>;
  return (g[KEY] ??= { jobs: new Map(), waiting: new Map(), seen: new Map() });
}

export const MESSAGES: Record<CaptureState, string> = {
  ok: 'Done.',
  offline: 'That computer is not connected. It may be asleep, switched off or offline.',
  paused: 'Screenshots are paused on that device.',
  locked: 'That computer is locked, so there is nothing to see.',
  off: 'Screen capture is switched off on that computer.',
  blank: 'The screen came back completely black, so it was not used.',
  error: 'That computer could not take the screenshot.',
  timeout: 'That computer took too long to answer.',
  busy: 'That computer is already taking a screenshot.',
  revoked: 'That device has been removed.',
};

export function isOnline(deviceId: string, now = Date.now()): boolean {
  const t = hub().seen.get(deviceId);
  return t !== undefined && now - t < ONLINE_MS;
}

function clamp(n: unknown, lo: number, hi: number, dflt: number): number {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : dflt;
}

export function cleanParams(p: Partial<Record<keyof CaptureParams, unknown>> = {}): CaptureParams {
  return { monitor: Math.floor(clamp(p.monitor, 0, 8, 0)), scale: clamp(p.scale, 0.1, 1, 0.5), quality: Math.floor(clamp(p.quality, 20, 95, 75)) };
}

/** Ask a device for one screenshot. Always resolves, and always writes one log line. */
export async function requestCapture(device: Device, requester: string, rawParams: Partial<Record<keyof CaptureParams, unknown>> = {}): Promise<CaptureResult> {
  const h = hub();
  const params = cleanParams(rawParams);
  const finish = (r: CaptureResult): CaptureResult => {
    appendLog({ op: 'capture', requester, deviceId: device.id, deviceName: device.name, state: r.state, bytes: r.image?.length ?? 0 });
    return r;
  };
  if (device.revokedAt) return finish({ state: 'revoked', message: MESSAGES.revoked });
  if (device.paused) return finish({ state: 'paused', message: MESSAGES.paused });
  if (!isOnline(device.id)) return finish({ state: 'offline', message: MESSAGES.offline });
  if ([...h.jobs.values()].some((j) => j.deviceId === device.id)) return finish({ state: 'busy', message: MESSAGES.busy });

  return new Promise<CaptureResult>((resolve) => {
    const id = crypto.randomBytes(8).toString('hex');
    const job: Job = { id, deviceId: device.id, params, requester, deviceName: device.name, picked: false, timers: [], settle: () => undefined };
    job.settle = (r) => {
      if (!h.jobs.delete(id)) return;
      job.timers.forEach(clearTimeout);
      resolve(finish(r));
    };
    h.jobs.set(id, job);
    job.timers.push(setTimeout(() => { if (!job.picked) job.settle({ state: 'offline', message: MESSAGES.offline }); }, ACK_MS));
    job.timers.push(setTimeout(() => job.settle({ state: 'timeout', message: MESSAGES.timeout }), RESULT_MS));
    const waiting = h.waiting.get(device.id);
    if (waiting) { h.waiting.delete(device.id); waiting(job); }
  });
}

/** The agent's poll. Resolves with the next job for this device, or null after the hold time. */
export function nextJob(deviceId: string, holdMs = POLL_HOLD_MS, now = Date.now()): Promise<{ id: string; params: CaptureParams } | null> {
  const h = hub();
  h.seen.set(deviceId, now);
  const take = (job: Job) => { job.picked = true; return { id: job.id, params: job.params }; };
  const ready = [...h.jobs.values()].find((j) => j.deviceId === deviceId && !j.picked);
  if (ready) return Promise.resolve(take(ready));
  return new Promise((resolve) => {
    const old = h.waiting.get(deviceId);
    if (old) old(null);                                    // a newer poll replaces an older one
    const timer = setTimeout(() => { if (h.waiting.get(deviceId) === wake) h.waiting.delete(deviceId); resolve(null); }, holdMs);
    const wake = (job: Job | null) => { clearTimeout(timer); resolve(job ? take(job) : null); };
    h.waiting.set(deviceId, wake);
  });
}

/** The agent hands the result back. A device can only answer its own jobs. */
export function deliverResult(device: Device, jobId: string, state: string, image: Buffer | null): boolean {
  const job = hub().jobs.get(jobId);
  if (!job || job.deviceId !== device.id) return false;
  const known = (s: string): s is CaptureState => s in MESSAGES && s !== 'offline' && s !== 'paused' && s !== 'revoked' && s !== 'timeout' && s !== 'busy';
  if (state === 'ok' && image && image.length > 0 && image.length <= MAX_IMAGE_BYTES) job.settle({ state: 'ok', image, message: MESSAGES.ok });
  else if (state !== 'ok' && known(state)) job.settle({ state, message: MESSAGES[state] });
  else job.settle({ state: 'error', message: MESSAGES.error });
  return true;
}

/** A revoked device's waiting jobs end at once. */
export function dropDevice(deviceId: string): void {
  const h = hub();
  for (const j of [...h.jobs.values()]) if (j.deviceId === deviceId) j.settle({ state: 'revoked', message: MESSAGES.revoked });
  h.waiting.get(deviceId)?.(null);
  h.waiting.delete(deviceId);
  h.seen.delete(deviceId);
}

export async function deviceFromToken(token: string | null): Promise<Device | null> {
  return authenticateDevice(token);
}
