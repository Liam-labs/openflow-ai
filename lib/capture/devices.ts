/**
 * Devices that may send screenshots to this computer's owner (remote screenshots in Riley Voice).
 *
 * File: .AppData/capture-devices.json  { devices: Device[], codes: Code[] }  and  .AppData/capture-log.jsonl
 * - The server keeps only the SHA-256 of each device token and each enrol code, never the value.
 * - A code is minted from the signed-in owner session, lives 45 minutes (60 at most) and works once.
 * - A revoked device is refused at once: authenticateDevice reads the file on every call.
 * - The log never holds a picture. It holds who asked, which device, the result and the size.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { DataPaths } from '../data-paths';
import { readJsonFileStrict, writeJsonFile, withFileLock } from '../data-io';

export const CODE_MINUTES = 45;
export const MAX_CODE_MINUTES = 60;
export const MAX_ACTIVE_DEVICES = 10;
export const LOG_MAX_BYTES = 2 * 1024 * 1024;

export interface Device {
  id: string;
  name: string;
  platform: string;
  tokenHash: string;
  createdAt: string;
  lastSeenAt?: string;
  paused: boolean;
  revokedAt?: string;
  revokedBy?: string;
}

interface Code { hash: string; expiresAt: string; usedAt?: string }
interface State { devices: Device[]; codes: Code[] }

export type PublicDevice = Omit<Device, 'tokenHash'> & { active: boolean };

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0 O 1 I

export const sha256 = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
export const normaliseCode = (c: unknown) => String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export function stateFile(): string { return path.join(path.dirname(DataPaths.dashboardAuth), 'capture-devices.json'); }
export function logFile(): string { return path.join(path.dirname(DataPaths.dashboardAuth), 'capture-log.jsonl'); }

async function read(file: string): Promise<State> {
  const raw = await readJsonFileStrict<Partial<State>>(file, {});
  return { devices: Array.isArray(raw?.devices) ? raw.devices : [], codes: Array.isArray(raw?.codes) ? raw.codes : [] };
}

function cleanName(v: unknown, fallback: string): string {
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f<>]/g, '').trim() : '';
  return s && s.length <= 60 ? s : fallback;
}

export function toPublic(d: Device): PublicDevice {
  const { tokenHash: _omit, ...rest } = d;
  void _omit;
  return { ...rest, active: !d.revokedAt };
}

export function newCode(): string {
  const b = crypto.randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i += 1) {
    out += ALPHABET[b[i] % ALPHABET.length];
    if (i % 4 === 3 && i < 11) out += '-';
  }
  return out;
}

export const newToken = () => `ofcap_${crypto.randomBytes(32).toString('base64url')}`;

/** The owner asks for a one-time code. Old and used codes are dropped here. */
export async function mintEnrolCode(minutes = CODE_MINUTES, now = Date.now(), file = stateFile()): Promise<{ code: string; expiresAt: string }> {
  const life = Math.min(Math.max(Math.floor(minutes) || CODE_MINUTES, 1), MAX_CODE_MINUTES);
  return withFileLock(file, async () => {
    const s = await read(file);
    s.codes = s.codes.filter((c) => !c.usedAt && Date.parse(c.expiresAt) > now);
    const code = newCode();
    const expiresAt = new Date(now + life * 60_000).toISOString();
    s.codes.push({ hash: sha256(normaliseCode(code)), expiresAt });
    await writeJsonFile(file, s);
    return { code, expiresAt };
  });
}

export type EnrolResult =
  | { ok: true; device: PublicDevice; token: string }
  | { ok: false; reason: 'bad_code' | 'too_many_devices' };

/** The device trades a code for its token. The code works once. A device with the same name is retired (a reinstall). */
export async function exchangeCode(code: unknown, name: unknown, platform: unknown, now = Date.now(), file = stateFile()): Promise<EnrolResult> {
  const hash = sha256(normaliseCode(code));
  return withFileLock(file, async () => {
    const s = await read(file);
    const match = s.codes.find((c) => c.hash === hash && !c.usedAt && Date.parse(c.expiresAt) > now);
    if (!match) return { ok: false, reason: 'bad_code' } as const;
    const label = cleanName(name, 'This computer');
    const stamp = new Date(now).toISOString();
    for (const d of s.devices) if (!d.revokedAt && d.name === label) { d.revokedAt = stamp; d.revokedBy = 'reinstall'; }
    if (s.devices.filter((d) => !d.revokedAt).length >= MAX_ACTIVE_DEVICES) return { ok: false, reason: 'too_many_devices' } as const;
    match.usedAt = stamp;
    const token = newToken();
    const device: Device = {
      id: `dev-${crypto.randomBytes(5).toString('hex')}`,
      name: label,
      platform: cleanName(platform, 'unknown').slice(0, 20),
      tokenHash: sha256(token),
      createdAt: stamp,
      paused: false,
    };
    s.devices.push(device);
    await writeJsonFile(file, s);
    return { ok: true, device: toPublic(device), token } as const;
  });
}

/** Who owns this token. A revoked, unknown or malformed token gives null. */
export async function authenticateDevice(token: unknown, file = stateFile()): Promise<Device | null> {
  if (typeof token !== 'string' || !token.startsWith('ofcap_') || token.length > 200) return null;
  const hash = sha256(token);
  const s = await read(file);
  const d = s.devices.find((x) => x.tokenHash === hash);
  return d && !d.revokedAt ? d : null;
}

export function bearer(request: { headers: { get(n: string): string | null } }): string | null {
  const h = request.headers.get('authorization') || '';
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1] : null;
}

export async function listDevices(file = stateFile()): Promise<PublicDevice[]> {
  return (await read(file)).devices.map(toPublic);
}

export async function updateDevice(id: string, patch: { name?: unknown; paused?: unknown }, file = stateFile()): Promise<PublicDevice | null> {
  return withFileLock(file, async () => {
    const s = await read(file);
    const d = s.devices.find((x) => x.id === id && !x.revokedAt);
    if (!d) return null;
    if (patch.name !== undefined) d.name = cleanName(patch.name, d.name);
    if (typeof patch.paused === 'boolean') d.paused = patch.paused;
    await writeJsonFile(file, s);
    return toPublic(d);
  });
}

export async function revokeDevice(id: string, by: string, now = Date.now(), file = stateFile()): Promise<PublicDevice | null> {
  return withFileLock(file, async () => {
    const s = await read(file);
    const d = s.devices.find((x) => x.id === id);
    if (!d) return null;
    if (!d.revokedAt) { d.revokedAt = new Date(now).toISOString(); d.revokedBy = by.slice(0, 40); }
    await writeJsonFile(file, s);
    return toPublic(d);
  });
}

export async function touchDevice(id: string, now = Date.now(), file = stateFile()): Promise<void> {
  await withFileLock(file, async () => {
    const s = await read(file);
    const d = s.devices.find((x) => x.id === id);
    if (!d) return;
    d.lastSeenAt = new Date(now).toISOString();
    await writeJsonFile(file, s);
  });
}

export interface LogEntry {
  op: 'enrol' | 'rename' | 'pause' | 'resume' | 'revoke' | 'self-revoke' | 'connect' | 'capture' | 'status';
  requester: string;
  deviceId?: string;
  deviceName?: string;
  state?: string;
  bytes?: number;
}

/** One JSON line per event. When the file passes its size cap, the oldest half is dropped. */
export function appendLog(entry: LogEntry, now = Date.now(), file = logFile(), maxBytes = LOG_MAX_BYTES): void {
  const safe = { at: new Date(now).toISOString(), ...entry, requester: String(entry.requester).slice(0, 60) };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > maxBytes) {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      fs.writeFileSync(file, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n', { mode: 0o600 });
    }
  } catch { /* a failed trim must not stop the log */ }
  fs.appendFileSync(file, JSON.stringify(safe) + '\n', { mode: 0o600 });
}

export function readLog(limit = 100, file = logFile()): Array<Record<string, unknown>> {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-Math.min(Math.max(limit, 1), 500)).reverse().flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  } catch { return []; }
}
