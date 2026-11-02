/** Runs a catalog install command that install-parse.ts approved, and says in plain words how it went. */
import { execFile } from 'child_process';
import type { Connector } from './catalog';
import { installArgv } from './install-parse';
import { ConnectorInputError } from './errors';

export interface InstallResult { ok: boolean; message: string }

export async function runInstall(c: Connector, run: typeof execFile = execFile): Promise<InstallResult> {
  const argv = installArgv(c.setup.command);
  if (!argv) throw new ConnectorInputError('This one cannot be installed from here. Copy the command and run it yourself.');
  return new Promise((resolve) => {
    run(argv[0], argv.slice(1), { timeout: 240_000, windowsHide: true, maxBuffer: 512 * 1024, env: process.env }, (err, _out, stderr) => {
      if (!err) return resolve({ ok: true, message: `${c.name} is installed.` });
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return resolve({ ok: false, message: `${argv[0] === 'docker' ? 'Docker is' : 'npm is'} not installed on this computer yet, so it cannot run this.` });
      const tail = String(stderr || '').trim().split('\n').filter(Boolean).slice(-2).join(' ').replace(/\s+/g, ' ').slice(0, 220);
      resolve({ ok: false, message: `The install did not finish${tail ? `: ${tail}` : '.'}` });
    });
  });
}
