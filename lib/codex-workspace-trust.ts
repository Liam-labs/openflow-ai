import { execFile } from 'child_process';
import { promisify } from 'util';
import { getDevflowHome } from '@/lib/home-dir';

const execFileAsync = promisify(execFile);
const TRUST_SCRIPT = `${getDevflowHome()}/scripts/codex_workspace_trust.py`;

/** Register one exact DevFlow-managed path in Codex's trusted-project config. */
export async function trustCodexWorkspace(workspace: string): Promise<void> {
  const trimmed = workspace.trim();
  if (!trimmed) {
    throw new Error('Cannot trust an empty Codex workspace path');
  }

  await execFileAsync('python3', [TRUST_SCRIPT, '--workspace', trimmed], {
    timeout: 10_000,
  });
}
