/**
 * The credential broker: lets an agent, or Jack, use a stored key without ever seeing it.
 *
 * One operation, runWithSecret(): run one named, allow-listed action with the secret names that action may use, in this process
 * only. The value is never returned, never put in an argument, a URL we log, an error or the audit line. Output has every secret
 * (and common encodings of it) replaced with [hidden], and when that cannot be checked nothing is returned at all.
 *
 * Who needs an approval: an agent or Jack, for every action, one approval per action, tied to the exact action, arguments and secret names,
 * ten minutes, spent when used. The signed-in owner pressing a button needs none. An approval can only be created by the signed-in owner
 * (the route checks that), so an agent can never approve itself.
 *
 * What it does not do (spec, broker-spec.md): the broker cannot create, change or delete a key, read other files or channels, or touch
 * the owner password. A provider key used by `start-agent` ends up in that agent's own process, which the agent's own tools can read.
 */
import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { DataPaths } from '@/lib/data-paths';
import { readJsonFile, writeJsonFile, withFileLock } from '@/lib/data-io';
import { resolveSecretStore, SecretStoreError, type SecretStore } from '@/lib/secret-store';

export const APPROVAL_TTL_MS = 10 * 60 * 1000;
export const HIDDEN = '[hidden]';

export type BrokerStatus = 'ok' | 'failed' | 'bad-request' | 'unknown-action' | 'refused' | 'needs-approval' | 'locked' | 'missing-key' | 'withheld';

export interface BrokerResult { ok: boolean; status: BrokerStatus; message: string; output: string }

/** One thing the broker may do. It states which secret names it may use, and it is the only code that ever sees the values. */
export interface BrokerAction<A = Record<string, unknown>> {
  id: string;
  /** Checks the non-secret arguments. Returns them cleaned, or a plain message when they are not acceptable. */
  validateArgs(args: unknown): A | string | Promise<A | string>;
  /** The secret names this action may use for these arguments. A request for any other name is refused. */
  names(args: A): string[] | Promise<string[]>;
  run(args: A, secrets: Record<string, string>): Promise<{ ok: boolean; message: string }>;
}

export type Actor = { kind: 'owner' } | { kind: 'agent'; name: string };

export interface BrokerRequest {
  action: string;
  args?: unknown;
  secretNames?: string[];
  approvalId?: string;
}

export interface BrokerDeps {
  actions: Record<string, BrokerAction<any>>;   // eslint-disable-line @typescript-eslint/no-explicit-any
  store?: SecretStore;
  now?: () => number;
  approvalsFile?: string;
  auditFile?: string;
}

const approvalsPath = (d: BrokerDeps) => d.approvalsFile ?? path.join(DataPaths.appData, 'broker-approvals.json');
const auditPath = (d: BrokerDeps) => d.auditFile ?? path.join(DataPaths.appData, 'broker-audit.jsonl');

/** Stable text for an action, its arguments and its secret names, so an approval matches exactly that and nothing else. */
export function fingerprint(action: string, args: unknown, names: string[]): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canon(x)]));
    return v;
  };
  return createHash('sha256').update(JSON.stringify({ action, args: canon(args ?? {}), names: [...names].sort() })).digest('hex');
}

interface Approval { id: string; fp: string; action: string; createdAt: number; expiresAt: number; usedAt?: number }
interface ApprovalsFile { approvals: Approval[] }

/** Owner only (the route checks): one approval for this exact action. */
export async function createApproval(action: string, args: unknown, names: string[], deps: BrokerDeps): Promise<{ approvalId: string; expiresAt: number } | { error: string }> {
  const found = await resolveAction(action, args, names, deps);
  if ('error' in found) return found;
  const now = (deps.now ?? Date.now)();
  const file = approvalsPath(deps);
  const approval: Approval = { id: randomUUID(), fp: fingerprint(action, found.args, found.names), action, createdAt: now, expiresAt: now + APPROVAL_TTL_MS };
  await withFileLock(file, async () => {
    const data = await readJsonFile<ApprovalsFile>(file, { approvals: [] });
    data.approvals = data.approvals.filter((a) => a.expiresAt > now && !a.usedAt).concat(approval);   // expired and spent ones are dropped
    await writeJsonFile(file, data);
  });
  return { approvalId: approval.id, expiresAt: approval.expiresAt };
}

/** Spends the approval if it exists, is unused, unexpired and is for exactly this. Never spends one that does not match. */
async function spendApproval(id: string | undefined, fp: string, deps: BrokerDeps): Promise<boolean> {
  if (!id || typeof id !== 'string') return false;
  const file = approvalsPath(deps);
  const now = (deps.now ?? Date.now)();
  return withFileLock(file, async () => {
    const data = await readJsonFile<ApprovalsFile>(file, { approvals: [] });
    const a = data.approvals.find((x) => x.id === id);
    if (!a || a.usedAt || a.expiresAt <= now || a.fp !== fp) return false;
    a.usedAt = now;
    await writeJsonFile(file, data);
    return true;
  });
}

async function resolveAction(action: string, rawArgs: unknown, requested: string[] | undefined, deps: BrokerDeps): Promise<{ action: BrokerAction<any>; args: unknown; names: string[] } | { error: string; status?: BrokerStatus }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const def = Object.prototype.hasOwnProperty.call(deps.actions, action) ? deps.actions[action] : undefined;
  if (!def) return { error: 'That action is not one the broker can run.', status: 'unknown-action' };
  const args = await def.validateArgs(rawArgs ?? {});
  if (typeof args === 'string') return { error: args, status: 'bad-request' };
  const allowed = await def.names(args);
  const names = requested && requested.length ? requested : allowed;
  if (!Array.isArray(names) || names.some((n) => typeof n !== 'string' || !allowed.includes(n))) return { error: 'That action may not use one of the secret names asked for.', status: 'refused' };
  return { action: def, args, names };
}

/** Every secret value, and the common ways it could be written out, must be gone from `text`. */
export function secretVariants(value: string): string[] {
  const b64 = Buffer.from(value, 'utf8').toString('base64');
  const variants = new Set<string>([
    value,
    b64,
    b64.replace(/=+$/, ''),
    b64.replace(/\+/g, '-').replace(/\//g, '_'),
    b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    encodeURIComponent(value),
    Buffer.from(value, 'utf8').toString('hex'),
    JSON.stringify(value).slice(1, -1),
  ]);
  return [...variants].filter((v) => v.length >= 4).sort((a, b) => b.length - a.length);
}

/** The text with every secret replaced by [hidden], or null when it cannot be shown to be clean. */
export function cleanOutput(text: string, secrets: string[]): string | null {
  const all = [...new Set(secrets.flatMap((s) => (s ? secretVariants(s) : [])))].sort((a, b) => b.length - a.length);
  let out = text;
  for (const v of all) out = out.split(v).join(HIDDEN);
  return all.some((v) => out.includes(v)) ? null : out;
}

async function audit(deps: BrokerDeps, actor: Actor, action: string, names: string[], approvalId: string | undefined, status: BrokerStatus): Promise<void> {
  const line = JSON.stringify({ t: new Date((deps.now ?? Date.now)()).toISOString(), by: actor.kind === 'owner' ? 'owner' : `agent:${actor.name}`, action, names, approval: approvalId ?? null, status });
  const file = auditPath(deps);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, line + '\n', { mode: 0o600 });
  } catch {
    // The audit line is best effort here: a call is not blocked by a full disk. It never holds a value.
  }
}

function result(status: BrokerStatus, message: string, output = ''): BrokerResult {
  return { ok: status === 'ok', status, message, output };
}

export async function runWithSecret(req: BrokerRequest, actor: Actor, deps: BrokerDeps): Promise<BrokerResult> {
  const action = typeof req.action === 'string' ? req.action : '';
  let names: string[] = Array.isArray(req.secretNames) ? req.secretNames : [];
  const done = async (r: BrokerResult): Promise<BrokerResult> => { await audit(deps, actor, action || '(none)', names.filter((n) => typeof n === 'string').slice(0, 8), req.approvalId, r.status); return r; };

  const found = await resolveAction(action, req.args, Array.isArray(req.secretNames) ? req.secretNames : undefined, deps).catch(() => ({ error: 'That request could not be read.', status: 'bad-request' as BrokerStatus }));
  if ('error' in found) return done(result(found.status ?? 'bad-request', found.error));
  names = found.names;

  // An agent needs an approval for this exact action. The owner's own button needs none.
  if (actor.kind === 'agent') {
    const ok = await spendApproval(req.approvalId, fingerprint(action, found.args, names), deps);
    if (!ok) return done(result('needs-approval', 'This needs the owner\'s approval for this exact action. Ask the owner, explain what it does, and try again with the approval.'));
  }

  const store = deps.store ?? resolveSecretStore();
  const secrets: Record<string, string> = {};
  try {
    for (const n of names) {
      const v = store.get(n);
      if (v === undefined || v === '') return done(result('missing-key', 'That key is not saved yet. The owner adds it in Connections.'));
      secrets[n] = v;
    }
  } catch (e) {
    if (e instanceof SecretStoreError) return done(result('locked', 'The key store cannot be opened right now (its encryption key is missing or does not match). Nothing was run.'));
    return done(result('failed', 'The key store could not be read. Nothing was run.'));
  }

  let outcome: { ok: boolean; message: string };
  try {
    outcome = await found.action.run(found.args, secrets);
  } catch {
    outcome = { ok: false, message: 'The action failed.' };
  }
  const clean = cleanOutput(String(outcome.message ?? ''), Object.values(secrets));
  if (clean === null) return done(result('withheld', 'The result could not be shown to be free of the key, so nothing is returned.'));
  return done(result(outcome.ok ? 'ok' : 'failed', clean, clean));
}
