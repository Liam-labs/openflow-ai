/** Translates a local spawn into a hostd spawn on the machine the agent lives on. */
import { basename } from 'node:path';
import { hostCall } from './host-executor';

export interface LauncherSpec { launcher: string; args: string[]; env: Record<string, string> }

const LAUNCHERS = new Set([
  'collab-claude', 'collab-codex', 'collab-grok', 'collab-antigravity',
  'collab-codex.py', 'collab-grok.py', 'collab-grok-acp.py', 'collab-agent.py', 'agy-launch.sh',
]);

export function shellSplit(cmd: string): string[] {
  const out: string[] = [];
  let cur = '', q: string | null = null, has = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      if (c === q) q = null;
      else if (c === '\\' && q === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else cur += c;
    } else if (c === '"' || c === "'") { q = c; has = true; }
    else if (/\s/.test(c)) { if (cur || has) out.push(cur); cur = ''; has = false; }
    else cur += c;
  }
  if (q) throw new Error('unbalanced quote in launch command');
  if (cur || has) out.push(cur);
  return out;
}

/** Parse "[KEY=v ...] [python3|bash] /path/launcher args..." into a hostd launcher spec. */
export function parseLaunchCommand(command: string): LauncherSpec {
  const t = shellSplit(command);
  const env: Record<string, string> = {};
  while (t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0])) {
    const [k, ...v] = t.shift()!.split('=');
    env[k] = v.join('=');
  }
  if (['python3', 'python', 'bash'].includes(t[0] ?? '')) t.shift();
  const launcher = basename(t.shift() ?? '');
  if (!LAUNCHERS.has(launcher)) throw new Error(`launcher "${launcher}" is not supported on a remote host`);
  return { launcher, args: t, env };
}

export function claudeWrapperSpec(o: {
  agentName: string; channelId: string; skipPermissions: boolean; resumeSessionId?: string;
  flags: string[]; systemPromptFile?: string;
}): LauncherSpec {
  const args = ['--name', o.agentName, '--channel', o.channelId];
  if (o.skipPermissions) args.push('--dangerously-skip-permissions');
  if (o.resumeSessionId) args.push('--resume', o.resumeSessionId);
  args.push(...o.flags);
  if (o.systemPromptFile) args.push('--system-prompt-file', o.systemPromptFile);
  return { launcher: 'collab-claude', args, env: {} };
}

/** Copies a local file's text to the host's scratch folder and returns the path to use there. */
export async function pushFile(host: string, localText: string, name: string): Promise<string> {
  const path = `/tmp/devflow-remote/${name}`;
  const r = await hostCall<{ path: string }>(host, 'write-file', { path, content: localText, mode: 0o600 });
  return r.path;
}

export async function spawnOnHost(host: string, p: { session: string; cwd: string; spec: LauncherSpec; selfSession?: boolean; replace?: boolean }) {
  return hostCall<{ alive: boolean }>(host, 'spawn', {
    session: p.session, cwd: p.cwd, launcher: p.spec.launcher, args: p.spec.args, env: p.spec.env,
    selfSession: p.selfSession || false,
    replace: p.replace === true,
  }, 90_000);
}
