/**
 * The OpenFlow connectors catalog: the optional apps, keys and tools a new install can set up.
 * One file (`data/connectors-catalog.json`) holds the list; this module types it and refuses a bad one.
 * Nothing here holds a credential: entries name the environment variable a key is stored under, never a value.
 */
import { promises as fs } from 'fs';
import path from 'path';

export type CostKind = 'free' | 'included' | 'free-tier' | 'pay-per-use' | 'paid-plan';
export type ConnectorKind = 'cli' | 'api-key' | 'mcp' | 'local-service';
export const COST_KINDS: readonly CostKind[] = ['free', 'included', 'free-tier', 'pay-per-use', 'paid-plan'];
export const CONNECTOR_KINDS: readonly ConnectorKind[] = ['cli', 'api-key', 'mcp', 'local-service'];
export const KEY_TESTS = ['openrouter', 'xai', 'deepseek', 'openai', 'replicate', 'pexels', 'resend', 'typesafe'] as const;
export type KeyTestId = (typeof KEY_TESTS)[number];

export interface McpInput { id: string; label: string; placeholder?: string; kind: 'folder' | 'text' }
export interface McpEnvInput { name: string; label: string; placeholder?: string }
export interface McpSpec {
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  /** Values the user supplies (a folder, say); `{id}` in `args` is replaced by what they typed. */
  inputs?: McpInput[];
  /** Secrets the server needs; stored in the connector env file and referenced as ${NAME}. */
  env?: McpEnvInput[];
  /** Fixed, non-secret settings. */
  fixedEnv?: Record<string, string>;
}

export interface Connector {
  id: string;
  name: string;
  category: string;
  kind: ConnectorKind;
  recommended?: boolean;
  /** What it is, in a few words, shown as the card's headline (the name is the fallback). */
  headline?: string;
  summary: string;
  /** Two to four short reasons it is worth setting up, shown when a card is opened out. */
  why?: string[];
  costKind: CostKind;
  cost: string;
  detect: { binary?: string; env?: string[]; mcp?: string; port?: number };
  authCheck?: string[];
  setup: {
    steps: string[];
    command?: string;
    /** Where the person goes to make the key or sign in: the provider's own page, opened by one button. */
    open?: { label: string; url: string };
    key?: { env: string; label: string; placeholder?: string; test?: KeyTestId };
    mcp?: McpSpec;
  };
  docs: string;
}

export interface ConnectorsCatalog {
  version: number;
  updated: string;
  note?: string;
  categories: { id: string; label: string }[];
  connectors: Connector[];
}

const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
const BINARY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;
const MCP_NAME = /^[a-z0-9][a-z0-9_-]{0,40}$/;
// A string that looks like a live credential must never ship in a public list.
const SECRET_LOOKING = /(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY)/;
// Private machines, accounts and addresses have no place in a public list.
const PRIVATE_LOOKING = /(\/home\/(?!node\/)[a-z]|\/Users\/[A-Za-z]|C:\\Users|\b192\.168\.|\b10\.\d+\.\d+\.\d+\b|\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+\b|\.ts\.net\b|@[a-z0-9-]+\.(co\.uk|com)\b)/i;

function isHttpsUrl(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  try { return new URL(v).protocol === 'https:'; } catch { return false; }
}

/** Every reason the catalog is unusable, in plain words; an empty list means it is fine. */
export function validateCatalog(raw: unknown): string[] {
  const errors: string[] = [];
  const c = raw as Partial<ConnectorsCatalog> | null;
  if (!c || typeof c !== 'object') return ['catalog is not an object'];
  if (typeof c.version !== 'number') errors.push('version must be a number');
  const categories = Array.isArray(c.categories) ? c.categories : [];
  if (!categories.length) errors.push('categories is empty');
  const categoryIds = new Set(categories.map((x) => x?.id));
  const list = Array.isArray(c.connectors) ? c.connectors : [];
  if (!list.length) errors.push('connectors is empty');
  const seen = new Set<string>();
  const mcpNames = new Set<string>();
  const envOwners = new Map<string, string>();

  for (const x of list) {
    const where = `connector ${x?.id ?? '(no id)'}`;
    if (!x || typeof x.id !== 'string' || !ID.test(x.id)) { errors.push(`${where}: bad id`); continue; }
    if (seen.has(x.id)) errors.push(`${where}: duplicate id`);
    seen.add(x.id);
    for (const f of ['name', 'summary', 'cost'] as const) {
      if (typeof x[f] !== 'string' || !x[f].trim()) errors.push(`${where}: ${f} is required`);
    }
    if (x.headline !== undefined && (typeof x.headline !== 'string' || !x.headline.trim() || x.headline.length > 60)) errors.push(`${where}: headline must be 1-60 characters`);
    if (x.why !== undefined && (!Array.isArray(x.why) || x.why.length > 4 || x.why.some((w) => typeof w !== 'string' || !w.trim() || w.length > 120))) errors.push(`${where}: why must be up to 4 short lines`);
    if (!categoryIds.has(x.category)) errors.push(`${where}: unknown category ${x.category}`);
    if (!CONNECTOR_KINDS.includes(x.kind)) errors.push(`${where}: bad kind ${x.kind}`);
    if (!COST_KINDS.includes(x.costKind)) errors.push(`${where}: bad costKind ${x.costKind}`);
    if (!isHttpsUrl(x.docs)) errors.push(`${where}: docs must be an https link`);
    if (!x.setup || !Array.isArray(x.setup.steps) || !x.setup.steps.length || x.setup.steps.some((s) => typeof s !== 'string' || !s.trim())) {
      errors.push(`${where}: setup.steps needs at least one step`);
    }
    if (x.setup?.open !== undefined && (!isHttpsUrl(x.setup.open.url) || typeof x.setup.open.label !== 'string' || !x.setup.open.label.trim() || x.setup.open.label.length > 50)) {
      errors.push(`${where}: setup.open needs a short label and an https url`);
    }
    const d = x.detect;
    if (!d || typeof d !== 'object' || (!d.binary && !d.env?.length && !d.mcp && !d.port)) {
      errors.push(`${where}: detect needs a binary, env, mcp or port`);
    } else {
      if (d.binary !== undefined && !BINARY.test(d.binary)) errors.push(`${where}: bad detect.binary`);
      for (const n of d.env ?? []) if (!ENV_NAME.test(n)) errors.push(`${where}: bad detect.env ${n}`);
      if (d.mcp !== undefined && !MCP_NAME.test(d.mcp)) errors.push(`${where}: bad detect.mcp`);
      if (d.port !== undefined && !(Number.isInteger(d.port) && d.port > 0 && d.port < 65536)) errors.push(`${where}: bad detect.port`);
    }
    if (x.authCheck && (!Array.isArray(x.authCheck) || !x.authCheck.every((a) => typeof a === 'string') || x.authCheck[0] !== d?.binary)) {
      errors.push(`${where}: authCheck must be an argv list that starts with the detect binary`);
    }
    // A connector's kind decides what setup it must offer.
    if (x.kind === 'api-key') {
      const k = x.setup?.key;
      if (!k || !ENV_NAME.test(k.env) || !k.label) errors.push(`${where}: api-key connector needs setup.key {env,label}`);
      else {
        const owner = envOwners.get(k.env);
        if (owner) errors.push(`${where}: env ${k.env} is already used by ${owner}`);
        envOwners.set(k.env, x.id);
        if (!x.detect?.env?.includes(k.env)) errors.push(`${where}: detect.env must list ${k.env}`);
        if (k.test !== undefined && !KEY_TESTS.includes(k.test)) errors.push(`${where}: unknown key test ${k.test}`);
      }
    }
    if (x.kind === 'cli' && !x.detect?.binary) errors.push(`${where}: cli connector needs detect.binary`);
    if (x.kind === 'mcp') {
      const m = x.setup?.mcp;
      if (!m || !MCP_NAME.test(m.name)) errors.push(`${where}: mcp connector needs setup.mcp.name`);
      else {
        if (mcpNames.has(m.name)) errors.push(`${where}: mcp name ${m.name} is used twice`);
        mcpNames.add(m.name);
        if (x.detect?.mcp !== m.name) errors.push(`${where}: detect.mcp must equal setup.mcp.name`);
        if (m.transport === 'stdio') {
          if (!m.command || !BINARY.test(m.command)) errors.push(`${where}: stdio mcp needs a plain command name`);
        } else if (m.transport === 'http') {
          if (!isHttpsUrl(m.url)) errors.push(`${where}: http mcp needs an https url`);
        } else errors.push(`${where}: bad mcp transport`);
        const inputIds = new Set((m.inputs ?? []).map((i) => i.id));
        for (const a of m.args ?? []) {
          for (const ref of a.match(/\{([a-z0-9_]+)\}/g) ?? []) {
            if (!inputIds.has(ref.slice(1, -1))) errors.push(`${where}: argument uses ${ref} but no input has that id`);
          }
        }
        for (const e of m.env ?? []) {
          if (!ENV_NAME.test(e.name)) errors.push(`${where}: bad mcp env name ${e.name}`);
          const owner = envOwners.get(e.name);
          if (owner && owner !== x.id) errors.push(`${where}: env ${e.name} is already used by ${owner}`);
          envOwners.set(e.name, x.id);
        }
        for (const [k, v] of Object.entries(m.fixedEnv ?? {})) {
          if (!ENV_NAME.test(k) || typeof v !== 'string') errors.push(`${where}: bad fixedEnv ${k}`);
        }
      }
    }
  }
  const text = JSON.stringify(raw);
  if (SECRET_LOOKING.test(text)) errors.push('the catalog contains something that looks like a real key');
  const priv = PRIVATE_LOOKING.exec(text);
  if (priv) errors.push(`the catalog contains something that looks private: ${priv[0]}`);
  return errors;
}

let cached: { at: number; value: ConnectorsCatalog } | null = null;

export function catalogPath(): string {
  return path.join(/* turbopackIgnore: true */ process.cwd(), 'data', 'connectors-catalog.json');
}

/** Reads and validates the catalog. A bad file throws with every problem listed, so nobody trusts half a list. */
export async function loadCatalog(file: string = catalogPath()): Promise<ConnectorsCatalog> {
  const useCache = file === catalogPath();
  if (useCache && cached && Date.now() - cached.at < 30_000) return cached.value;
  const raw = JSON.parse(await fs.readFile(file, 'utf-8')) as unknown;
  const errors = validateCatalog(raw);
  if (errors.length) throw new Error(`connectors catalog is invalid: ${errors.join('; ')}`);
  const value = raw as ConnectorsCatalog;
  if (useCache) cached = { at: Date.now(), value };
  return value;
}
