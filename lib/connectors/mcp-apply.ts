/**
 * Adds a catalog MCP server to the user's own Claude Code and Codex lists, through their own `mcp add` commands.
 * Claude's user list (not one agent's file) reaches every Claude agent the next time it starts.
 * Programs run with an argument list, never through a shell; user input is checked before it goes in;
 * a secret is passed as a ${NAME} reference that the agent's environment fills in, never as the value.
 */
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { getHomeDir } from '@/lib/home-dir';
import { ConnectorInputError } from '@/lib/connectors/errors';
import type { Connector, McpSpec } from '@/lib/connectors/catalog';
import { searchDirs, binaryOnDisk } from '@/lib/connectors/detect';

export type StepResult = { target: 'claude' | 'codex'; outcome: 'added' | 'removed' | 'already' | 'not-installed' | 'needs-manual' | 'failed'; message: string };
export interface ApplyResult { ok: boolean; results: StepResult[] }

export type Runner = (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<{ code: number; stderr: string }>;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export function realRunner(timeoutMs = 30_000): Runner {
  return (file, args, env) => new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, env, windowsHide: true, maxBuffer: 256 * 1024 }, (err, _out, stderr) => {
      const exit = (err as { code?: unknown } | null)?.code;
      const code = !err ? 0 : typeof exit === 'number' ? exit : 1;
      resolve({ code, stderr: String(stderr ?? '').slice(0, 400) });
    });
  });
}

/** Turns what the user typed into the values the spec needs, or throws a message that is safe to show. */
export async function resolveInputs(spec: McpSpec, typed: Record<string, unknown>, home: string = getHomeDir()): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const input of spec.inputs ?? []) {
    const raw = typed[input.id];
    if (typeof raw !== 'string' || !raw.trim()) throw new ConnectorInputError(`${input.label} is needed.`);
    let v = raw.trim();
    if (v.length > 400 || CONTROL.test(v)) throw new ConnectorInputError(`${input.label} has a character that is not allowed.`);
    if (input.kind === 'folder') {
      if (v === '~') v = home;
      else if (v.startsWith('~/')) v = path.join(home, v.slice(2));
      if (!path.isAbsolute(v)) throw new ConnectorInputError(`${input.label} must be a full path such as ~/projects.`);
      v = path.resolve(v);
      if (v === path.parse(v).root) throw new ConnectorInputError('Choose a folder, not the whole disk.');
      let stat;
      try { stat = await fs.stat(v); } catch { throw new ConnectorInputError(`${input.label} does not exist.`); }
      if (!stat.isDirectory()) throw new ConnectorInputError(`${input.label} is not a folder.`);
    }
    out[input.id] = v;
  }
  return out;
}

export function fillArgs(args: string[] | undefined, values: Record<string, string>): string[] {
  return (args ?? []).map((a) => a.replace(/\{([a-z0-9_]+)\}/g, (_m, id: string) => values[id] ?? ''));
}

/** The JSON Claude's `mcp add-json` takes. Secrets are ${NAME} references. */
export function claudeJson(spec: McpSpec, values: Record<string, string>): Record<string, unknown> {
  if (spec.transport === 'http') return { type: 'http', url: spec.url };
  const env: Record<string, string> = { ...(spec.fixedEnv ?? {}) };
  for (const e of spec.env ?? []) env[e.name] = '${' + e.name + '}';
  const json: Record<string, unknown> = { type: 'stdio', command: spec.command, args: fillArgs(spec.args, values) };
  if (Object.keys(env).length) json.env = env;
  return json;
}

export function codexArgs(spec: McpSpec, values: Record<string, string>): string[] {
  if (spec.transport === 'http') return ['mcp', 'add', spec.name, '--url', spec.url!];
  const args = ['mcp', 'add', spec.name];
  for (const [k, v] of Object.entries(spec.fixedEnv ?? {})) args.push('--env', `${k}=${v}`);
  args.push('--', spec.command!, ...fillArgs(spec.args, values));
  return args;
}

async function listedIn(file: string, name: string): Promise<boolean> {
  try {
    const json = JSON.parse(await fs.readFile(file, 'utf-8')) as { mcpServers?: Record<string, unknown> };
    return Object.prototype.hasOwnProperty.call(json.mcpServers ?? {}, name);
  } catch { return false; }
}

async function codexListed(home: string, name: string): Promise<boolean> {
  try {
    const toml = await fs.readFile(path.join(home, '.codex', 'config.toml'), 'utf-8');
    return new RegExp(`^\\[mcp_servers\\.${name.replace(/[^A-Za-z0-9_-]/g, '')}\\]`, 'm').test(toml);
  } catch { return false; }
}

export async function addMcp(
  connector: Connector,
  typed: Record<string, unknown>,
  savedKeyNames: ReadonlySet<string>,
  opts: { home?: string; run?: Runner; hasBinary?: (name: string) => Promise<boolean> } = {},
): Promise<ApplyResult> {
  const spec = connector.setup.mcp;
  if (!spec) throw new ConnectorInputError('This connector has no MCP server to add.');
  const home = opts.home ?? getHomeDir();
  for (const e of spec.env ?? []) {
    if (!savedKeyNames.has(e.name)) throw new ConnectorInputError(`Save the ${e.label} first.`);
  }
  const values = await resolveInputs(spec, typed, home);
  const dirs = await searchDirs(home);
  const hasBinary = opts.hasBinary ?? ((n: string) => binaryOnDisk(n, dirs));
  const run = opts.run ?? realRunner();
  const env = { ...process.env, HOME: home, PATH: [...dirs, process.env.PATH ?? ''].join(path.delimiter) };
  const results: StepResult[] = [];

  // Claude
  if (!(await hasBinary('claude'))) {
    results.push({ target: 'claude', outcome: 'not-installed', message: 'Claude Code is not installed on this machine.' });
  } else if (await listedIn(path.join(home, '.claude.json'), spec.name)) {
    results.push({ target: 'claude', outcome: 'already', message: 'Already in the Claude list.' });
  } else {
    const r = await run('claude', ['mcp', 'add-json', '--scope', 'user', spec.name, JSON.stringify(claudeJson(spec, values))], env);
    results.push(r.code === 0
      ? { target: 'claude', outcome: 'added', message: 'Added for Claude. Agents pick it up the next time they start.' }
      : { target: 'claude', outcome: 'failed', message: `Claude refused it: ${r.stderr.trim() || 'no reason given'}` });
  }

  // Codex: its command line cannot reference a saved secret, so a server that needs one is left for the user.
  if (!(await hasBinary('codex'))) {
    results.push({ target: 'codex', outcome: 'not-installed', message: 'Codex is not installed on this machine.' });
  } else if (spec.env?.length) {
    results.push({ target: 'codex', outcome: 'needs-manual', message: 'Codex cannot read a saved key from here. Add this server to Codex yourself if you want it there.' });
  } else if (await codexListed(home, spec.name)) {
    results.push({ target: 'codex', outcome: 'already', message: 'Already in the Codex list.' });
  } else {
    const r = await run('codex', codexArgs(spec, values), env);
    results.push(r.code === 0
      ? { target: 'codex', outcome: 'added', message: 'Added for Codex. Codex agents pick it up the next time they start.' }
      : { target: 'codex', outcome: 'failed', message: `Codex refused it: ${r.stderr.trim() || 'no reason given'}` });
  }

  const ok = results.some((r) => r.outcome === 'added' || r.outcome === 'already') && !results.some((r) => r.outcome === 'failed');
  return { ok, results };
}

export async function removeMcp(
  connector: Connector,
  opts: { home?: string; run?: Runner; hasBinary?: (name: string) => Promise<boolean> } = {},
): Promise<ApplyResult> {
  const spec = connector.setup.mcp;
  if (!spec) throw new ConnectorInputError('This connector has no MCP server to remove.');
  const home = opts.home ?? getHomeDir();
  const dirs = await searchDirs(home);
  const hasBinary = opts.hasBinary ?? ((n: string) => binaryOnDisk(n, dirs));
  const run = opts.run ?? realRunner();
  const env = { ...process.env, HOME: home, PATH: [...dirs, process.env.PATH ?? ''].join(path.delimiter) };
  const results: StepResult[] = [];
  if (await hasBinary('claude') && await listedIn(path.join(home, '.claude.json'), spec.name)) {
    const r = await run('claude', ['mcp', 'remove', '--scope', 'user', spec.name], env);
    results.push(r.code === 0 ? { target: 'claude', outcome: 'removed', message: 'Removed from the Claude list.' } : { target: 'claude', outcome: 'failed', message: r.stderr.trim() || 'Claude could not remove it.' });
  }
  if (await hasBinary('codex') && await codexListed(home, spec.name)) {
    const r = await run('codex', ['mcp', 'remove', spec.name], env);
    results.push(r.code === 0 ? { target: 'codex', outcome: 'removed', message: 'Removed from the Codex list.' } : { target: 'codex', outcome: 'failed', message: r.stderr.trim() || 'Codex could not remove it.' });
  }
  return { ok: results.length > 0 && !results.some((r) => r.outcome === 'failed'), results };
}
